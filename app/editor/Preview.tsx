"use client";

import { CSSProperties, memo, useEffect, useRef, useState } from "react";
import { captionLines, SubtitleMode, SubtitleStyle } from "./captions";
import { Asset, Clip, clipEnd, evaluateVisual, evaluateVolume, Project, sourceTimeAt, Subtitle, trackClips } from "./model";

export type { SubtitleStyle } from "./captions";

function rgba(hex: string, percent: number) {
  const value = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) || 0);
  return `rgba(${r},${g},${b},${percent / 100})`;
}

// Mirrors createAss in electron/video-export.cjs: a background box replaces the outline, as libass BorderStyle 3 does.
function CaptionOverlay({ subtitle, mode, style, scale }: { subtitle: Subtitle; mode: SubtitleMode; style: SubtitleStyle; scale: number }) {
  const lines = captionLines(subtitle, mode, style);
  if (!lines.length) return null;
  const boxed = style.backgroundOpacity > 0;
  const placement: CSSProperties = style.position === "top" ? { top: `${style.offset}%` } : style.position === "middle" ? { top: "50%", transform: "translate(-50%, -50%)" } : { bottom: `${style.offset}%` };
  return <div className="caption-preview" style={{ ...placement, fontFamily: style.fontFamily }}>
    {lines.map((line, index) => {
      const primary = index === 0;
      const size = style.fontSize * scale * (primary || mode !== "both" ? 1 : style.enScale / 100);
      return <span key={line.lang} className={`caption-line${primary ? " primary" : ""}`} style={{
        color: line.lang === "en" && mode === "both" ? style.enColor : style.color,
        fontSize: `${Math.max(7, size)}px`,
        WebkitTextStroke: boxed ? undefined : `${style.outlineWidth * scale}px ${style.outlineColor}`,
        paintOrder: "stroke fill",
        background: boxed ? rgba(style.backgroundColor, style.backgroundOpacity) : "transparent",
      }}>{line.text}</span>;
    })}
  </div>;
}

type LayerProps = { clip: Clip; asset: Asset; time: number; playing: boolean; muted: boolean; frame: { width: number; height: number } };

// Mirrors the exporter: brightness then contrast, red/blue gain for temperature, then effects.
function cssFilter(clip: Clip, frameHeight: number) {
  const { brightness, contrast, saturation, temperature } = clip.adjust;
  const parts = [`brightness(${1 + brightness})`, `contrast(${contrast})`, `saturate(${saturation})`];
  if (temperature || clip.effects.includes("chroma-key")) parts.push(`url(#fx-${clip.id})`);
  for (const effect of clip.effects) {
    if (effect === "bw") parts.push("grayscale(1)");
    if (effect === "vintage") parts.push("sepia(1)");
    if (effect === "blur") parts.push(`blur(${(8 * frameHeight) / 1080}px)`);
    if (effect === "sharpen") parts.push("contrast(1.06)");
    if (effect === "beauty") parts.push(`blur(${(0.6 * frameHeight) / 1080}px)`);
  }
  return parts.join(" ");
}

// Approximates the exporter's chromakey: alpha drops where the key channel dominates.
function chromaMatrix(color: string, similarity: number) {
  const value = color.replace("#", "");
  const rgb = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) || 0);
  const key = rgb.indexOf(Math.max(...rgb));
  const strength = 1.2 + similarity * 3;
  const alpha = [strength, strength, strength].map((weight, channel) => channel === key ? -2 * weight : weight);
  return `1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  ${alpha.join(" ")} 0 1`;
}

function syncMedia(element: HTMLMediaElement, clip: Clip, time: number, playing: boolean, muted: boolean) {
  const target = sourceTimeAt(clip, time);
  element.muted = muted || clip.freezeAt !== null;
  element.volume = Math.max(0, Math.min(1, evaluateVolume(clip, time)));
  const live = playing && !clip.reverse && clip.freezeAt === null;
  if (live) {
    element.playbackRate = Math.max(0.0625, Math.min(16, clip.speed));
    if (Math.abs(element.currentTime - target) > 0.3) element.currentTime = target;
    if (element.paused) element.play().catch(() => undefined);
  } else {
    if (!element.paused) element.pause();
    if (!element.seeking && Math.abs(element.currentTime - target) > 0.04) element.currentTime = target;
  }
}

const VisualLayer = memo(function VisualLayer({ clip, asset, time, playing, muted, frame }: LayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (videoRef.current) syncMedia(videoRef.current, clip, time, playing, muted);
  }, [clip, muted, playing, time]);
  const state = evaluateVisual(clip, time);
  const cropWidth = asset.width * clip.crop.w;
  const cropHeight = asset.height * clip.crop.h;
  const quarter = clip.rotate90 === 90 || clip.rotate90 === 270;
  const fit = Math.min(frame.width / (quarter ? cropHeight : cropWidth), frame.height / (quarter ? cropWidth : cropHeight)) * state.scale;
  const boxWidth = (quarter ? cropHeight : cropWidth) * fit;
  const boxHeight = (quarter ? cropWidth : cropHeight) * fit;
  const outer: CSSProperties = {
    left: frame.width / 2 + state.x * frame.width - boxWidth / 2,
    top: frame.height / 2 + state.y * frame.height - boxHeight / 2,
    width: boxWidth,
    height: boxHeight,
    opacity: state.opacity,
    transform: `rotate(${state.rotation}deg)`,
    filter: cssFilter(clip, frame.height),
  };
  const inner: CSSProperties = {
    width: cropWidth * fit,
    height: cropHeight * fit,
    transform: `translate(-50%, -50%) rotate(${clip.rotate90}deg) scaleX(${clip.mirror ? -1 : 1})`,
  };
  const media: CSSProperties = { width: asset.width * fit, height: asset.height * fit, left: -clip.crop.x * asset.width * fit, top: -clip.crop.y * asset.height * fit };
  return <div className="preview-layer" style={outer}>
    {(clip.adjust.temperature !== 0 || clip.effects.includes("chroma-key")) && <svg className="svg-defs" aria-hidden="true"><filter id={`fx-${clip.id}`} colorInterpolationFilters="sRGB">
      {clip.adjust.temperature !== 0 && <feColorMatrix type="matrix" values={`${1 + 0.15 * clip.adjust.temperature} 0 0 0 0  0 1 0 0 0  0 0 ${1 - 0.15 * clip.adjust.temperature} 0 0  0 0 0 1 0`} />}
      {clip.effects.includes("chroma-key") && <feColorMatrix type="matrix" values={chromaMatrix(clip.chromaKey.color, clip.chromaKey.similarity)} />}
    </filter></svg>}
    <div className="preview-crop" style={inner}>
      {asset.kind === "video"
        ? <video ref={videoRef} src={asset.url} style={media} playsInline preload="auto" />
        // eslint-disable-next-line @next/next/no-img-element -- local blob URLs cannot use next/image
        : <img src={asset.url} alt="" style={media} draggable={false} />}
    </div>
    {clip.effects.includes("vignette") && <i className="preview-vignette" />}
  </div>;
});

const AudioLayer = memo(function AudioLayer({ clip, asset, time, playing, muted }: Omit<LayerProps, "frame">) {
  const audioRef = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (audioRef.current) syncMedia(audioRef.current, clip, time, playing, muted);
  }, [clip, muted, playing, time]);
  return <audio ref={audioRef} src={asset.url} preload="auto" />;
});

type PreviewProps = {
  project: Project;
  assets: Map<string, Asset>;
  time: number;
  playing: boolean;
  muted: boolean;
  ratio: "16:9" | "9:16";
  subtitleMode: SubtitleMode;
  subtitleStyle: SubtitleStyle;
  onImport: () => void;
};

export function Preview({ project, assets, time, playing, muted, ratio, subtitleMode, subtitleStyle, onImport }: PreviewProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ width: 640, height: 360 });
  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setFrame({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const visualTracks = project.tracks.filter((track) => track.kind === "video" && !track.hidden).reverse();
  const layers = visualTracks.flatMap((track) => {
    const clip = trackClips(project, track.id).find((item) => time >= item.start && time < clipEnd(item));
    const asset = clip && assets.get(clip.assetId);
    return clip && asset && asset.kind !== "audio" ? [{ clip, asset, muted: muted || track.muted }] : [];
  });
  const audioLayers = project.tracks.filter((track) => track.kind === "audio").flatMap((track) => {
    const clip = trackClips(project, track.id).find((item) => time >= item.start && time < clipEnd(item));
    const asset = clip && assets.get(clip.assetId);
    return clip && asset ? [{ clip, asset, muted: muted || track.muted }] : [];
  });
  const subtitle: Subtitle | undefined = project.subtitles.find((item) => time >= item.start && time < item.end);
  const scale = frame.height / 1080;
  return <div ref={frameRef} className={`video-frame ratio-${ratio.replace(":", "-")}`}>
    {layers.map(({ clip, asset, muted: layerMuted }) => <VisualLayer key={clip.id} clip={clip} asset={asset} time={time} playing={playing} muted={layerMuted} frame={frame} />)}
    {audioLayers.map(({ clip, asset, muted: layerMuted }) => <AudioLayer key={clip.id} clip={clip} asset={asset} time={time} playing={playing} muted={layerMuted} />)}
    {!project.clips.length && <button className="empty-stage" onClick={onImport}><span>＋</span><strong>导入素材开始创作</strong><small>导入后从左侧素材库拖到时间轴</small></button>}
    {subtitle && <CaptionOverlay subtitle={subtitle} mode={subtitleMode} style={subtitleStyle} scale={scale} />}
  </div>;
}
