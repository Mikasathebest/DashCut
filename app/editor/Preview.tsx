"use client";

import { CSSProperties, memo, useEffect, useMemo, useRef, useState } from "react";
import { captionLines, SubtitleMode, SubtitleStyle } from "./captions";
import { Asset, Clip, clipEnd, evaluateVisual, evaluateVolume, Project, renderClips, sourceTimeAt, speedAt, Subtitle, textBaseScale } from "./model";
import { measureText, renderText } from "./text";

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

type LayerProps = { clip: Clip; asset: Asset; time: number; rate: number; muted: boolean; frame: { width: number; height: number }; ratio: "16:9" | "9:16" };

/* ------------------------------------------------------------ audio */

// Routing media through Web Audio lets preview volume exceed 100% and approximates the export's audio effects.
type AudioChain = { gain: GainNode; highpass: BiquadFilterNode; lowpass: BiquadFilterNode; compressor: DynamicsCompressorNode };
let audioContext: AudioContext | null = null;
const chains = new WeakMap<HTMLMediaElement, AudioChain | null>();

function audioChain(element: HTMLMediaElement) {
  if (chains.has(element)) return chains.get(element)!;
  try {
    audioContext ??= new AudioContext();
    const source = audioContext.createMediaElementSource(element);
    const highpass = audioContext.createBiquadFilter();
    highpass.type = "highpass";
    const lowpass = audioContext.createBiquadFilter();
    lowpass.type = "lowpass";
    const compressor = audioContext.createDynamicsCompressor();
    const gain = audioContext.createGain();
    source.connect(highpass).connect(lowpass).connect(compressor).connect(gain).connect(audioContext.destination);
    const chain = { gain, highpass, lowpass, compressor };
    chains.set(element, chain);
    return chain;
  } catch {
    chains.set(element, null);
    return null;
  }
}

function applyAudio(element: HTMLMediaElement, clip: Clip, time: number, muted: boolean) {
  const volume = muted ? 0 : evaluateVolume(clip, time);
  const chain = audioChain(element);
  if (!chain) {
    element.volume = Math.max(0, Math.min(1, volume));
    return;
  }
  element.volume = 1;
  const effects = clip.audio.effects;
  const enhance = effects.includes("voice-enhance");
  const level = effects.includes("loudnorm");
  chain.highpass.frequency.value = effects.includes("denoise") ? 100 : enhance ? 80 : 10;
  chain.lowpass.frequency.value = effects.includes("denoise") ? 9000 : 22000;
  chain.compressor.threshold.value = enhance || level ? -24 : 0;
  chain.compressor.ratio.value = enhance ? 3 : level ? 4 : 1;
  chain.gain.gain.value = volume * (enhance ? 1.3 : level ? 1.4 : 1);
  if (audioContext?.state === "suspended") void audioContext.resume();
}

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

function syncMedia(element: HTMLMediaElement, clip: Clip, time: number, rate: number, muted: boolean) {
  const target = sourceTimeAt(clip, time);
  element.muted = muted || clip.freezeAt !== null;
  applyAudio(element, clip, time, muted);
  // Reverse clips and backwards shuttling are shown by seeking frame by frame.
  const live = rate > 0 && !clip.reverse && clip.freezeAt === null;
  if (live) {
    element.playbackRate = Math.max(0.0625, Math.min(16, speedAt(clip, time) * rate));
    if (Math.abs(element.currentTime - target) > 0.3) element.currentTime = target;
    if (element.paused) element.play().catch(() => undefined);
  } else {
    if (!element.paused) element.pause();
    if (!element.seeking && Math.abs(element.currentTime - target) > 0.04) element.currentTime = target;
  }
}

/* ------------------------------------------------------------ GIFs and titles */

type DecodedGif = { frames: ImageBitmap[]; ends: number[]; total: number };
const gifCache = new Map<string, Promise<DecodedGif | null>>();

/** Decodes every GIF frame once so preview shows the frame the export will use at each time. */
function decodeGif(url: string) {
  if (!gifCache.has(url)) {
    gifCache.set(url, (async () => {
      const Decoder = (globalThis as { ImageDecoder?: new (init: { data: ReadableStream | ArrayBuffer; type: string }) => { tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null }; decode: (options: { frameIndex: number }) => Promise<{ image: VideoFrame }>; close: () => void } }).ImageDecoder;
      if (!Decoder) return null;
      try {
        const data = await (await fetch(url)).arrayBuffer();
        const decoder = new Decoder({ data, type: "image/gif" });
        await decoder.tracks.ready;
        const count = decoder.tracks.selectedTrack?.frameCount ?? 0;
        const frames: ImageBitmap[] = [];
        const ends: number[] = [];
        let total = 0;
        for (let index = 0; index < count; index += 1) {
          const { image } = await decoder.decode({ frameIndex: index });
          // GIF frame delays under 20 ms are shown as 100 ms by browsers and FFmpeg alike.
          const delay = (image.duration ?? 0) / 1e6;
          total += delay < 0.02 ? 0.1 : delay;
          ends.push(total);
          frames.push(await createImageBitmap(image));
          image.close();
        }
        decoder.close();
        return frames.length ? { frames, ends, total } : null;
      } catch {
        return null;
      }
    })());
  }
  return gifCache.get(url)!;
}

function GifFrame({ url, sourceTime, style }: { url: string; sourceTime: number; style: CSSProperties }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [gif, setGif] = useState<DecodedGif | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void decodeGif(url).then((value) => { if (alive) setGif(value); });
    return () => { alive = false; };
  }, [url]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !gif) return;
    const local = ((sourceTime % gif.total) + gif.total) % gif.total;
    const index = Math.max(0, gif.ends.findIndex((end) => local < end));
    const bitmap = gif.frames[index];
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  }, [gif, sourceTime]);
  // eslint-disable-next-line @next/next/no-img-element -- fallback when ImageDecoder is unavailable
  if (gif === null) return <img src={url} alt="" style={style} draggable={false} />;
  return <canvas ref={canvasRef} style={style} />;
}

const VisualLayer = memo(function VisualLayer({ clip, asset, time, rate, muted, frame, ratio }: LayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (videoRef.current) syncMedia(videoRef.current, clip, time, rate, muted);
  }, [clip, muted, rate, time]);
  const textStyle = clip.text;
  // Titles are rendered by the same code the exporter uses, at twice the preview density.
  const title = useMemo(() => {
    if (asset.kind !== "text" || !textStyle) return null;
    const box = measureText(textStyle);
    return { box, url: renderText(textStyle, (frame.height / 1080) * 2).canvas.toDataURL("image/png") };
  }, [asset.kind, frame.height, textStyle]);
  const state = evaluateVisual(clip, time);
  if (title) state.scale *= textBaseScale(title.box.width, title.box.height, ratio);
  const mediaWidth = title ? title.box.width : asset.width;
  const mediaHeight = title ? title.box.height : asset.height;
  const cropWidth = mediaWidth * clip.crop.w;
  const cropHeight = mediaHeight * clip.crop.h;
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
    clipPath: state.wipe ? (state.wipe.from === "left" ? `inset(0 ${(1 - state.wipe.visible) * 100}% 0 0)` : `inset(0 0 0 ${(1 - state.wipe.visible) * 100}%)`) : undefined,
  };
  const inner: CSSProperties = {
    width: cropWidth * fit,
    height: cropHeight * fit,
    transform: `translate(-50%, -50%) rotate(${clip.rotate90}deg) scaleX(${clip.mirror ? -1 : 1})`,
  };
  const media: CSSProperties = { width: mediaWidth * fit, height: mediaHeight * fit, left: -clip.crop.x * mediaWidth * fit, top: -clip.crop.y * mediaHeight * fit };
  return <div className="preview-layer" style={outer}>
    {(clip.adjust.temperature !== 0 || clip.effects.includes("chroma-key")) && <svg className="svg-defs" aria-hidden="true"><filter id={`fx-${clip.id}`} colorInterpolationFilters="sRGB">
      {clip.adjust.temperature !== 0 && <feColorMatrix type="matrix" values={`${1 + 0.15 * clip.adjust.temperature} 0 0 0 0  0 1 0 0 0  0 0 ${1 - 0.15 * clip.adjust.temperature} 0 0  0 0 0 1 0`} />}
      {clip.effects.includes("chroma-key") && <feColorMatrix type="matrix" values={chromaMatrix(clip.chromaKey.color, clip.chromaKey.similarity)} />}
    </filter></svg>}
    <div className="preview-crop" style={inner}>
      {asset.kind === "video"
        ? <video ref={videoRef} src={asset.url} style={media} playsInline preload="auto" crossOrigin="anonymous" />
        : asset.kind === "gif" ? <GifFrame url={asset.url} sourceTime={sourceTimeAt(clip, time)} style={media} />
          // eslint-disable-next-line @next/next/no-img-element -- local blob URLs cannot use next/image
          : <img src={title ? title.url : asset.url} alt="" style={media} draggable={false} />}
    </div>
    {clip.effects.includes("vignette") && <i className="preview-vignette" />}
  </div>;
});

const AudioLayer = memo(function AudioLayer({ clip, asset, time, rate, muted }: Omit<LayerProps, "frame" | "ratio">) {
  const audioRef = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (audioRef.current) syncMedia(audioRef.current, clip, time, rate, muted);
  }, [clip, muted, rate, time]);
  return <audio ref={audioRef} src={asset.url} preload="auto" crossOrigin="anonymous" />;
});

type PreviewProps = {
  project: Project;
  assets: Map<string, Asset>;
  time: number;
  /** Clock speed: 1 = normal play, 2/4 = fast, negative = shuttling backwards, 0 = paused. */
  rate: number;
  muted: boolean;
  ratio: "16:9" | "9:16";
  subtitleMode: SubtitleMode;
  subtitleStyle: SubtitleStyle;
  onImport: () => void;
};

export function Preview({ project, assets, time, rate, muted, ratio, subtitleMode, subtitleStyle, onImport }: PreviewProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ width: 640, height: 360 });
  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setFrame({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Transitions make neighbouring clips overlap, so a track can show more than one clip at once.
  const drawn = useMemo(() => renderClips(project, assets), [assets, project]);
  const active = (trackId: string) => drawn.filter((clip) => clip.trackId === trackId && time >= clip.start && time < clipEnd(clip)).sort((a, b) => a.start - b.start);
  const visualTracks = project.tracks.filter((track) => track.kind === "video" && !track.hidden).reverse();
  const layers = visualTracks.flatMap((track) => active(track.id).flatMap((clip) => {
    const asset = assets.get(clip.assetId);
    return asset && asset.kind !== "audio" ? [{ clip, asset, muted: muted || track.muted }] : [];
  }));
  const audioLayers = project.tracks.filter((track) => track.kind === "audio").flatMap((track) => active(track.id).flatMap((clip) => {
    const asset = assets.get(clip.assetId);
    return asset ? [{ clip, asset, muted: muted || track.muted }] : [];
  }));
  const subtitle: Subtitle | undefined = project.subtitles.find((item) => time >= item.start && time < item.end);
  const scale = frame.height / 1080;
  return <div ref={frameRef} className={`video-frame ratio-${ratio.replace(":", "-")}`}>
    {layers.map(({ clip, asset, muted: layerMuted }) => <VisualLayer key={clip.id} clip={clip} asset={asset} time={time} rate={rate} muted={layerMuted} frame={frame} ratio={ratio} />)}
    {audioLayers.map(({ clip, asset, muted: layerMuted }) => <AudioLayer key={clip.id} clip={clip} asset={asset} time={time} rate={rate} muted={layerMuted} />)}
    {!project.clips.length && <button className="empty-stage" onClick={onImport}><span>＋</span><strong>导入素材开始创作</strong><small>导入后从左侧素材库拖到时间轴</small></button>}
    {subtitle && <CaptionOverlay subtitle={subtitle} mode={subtitleMode} style={subtitleStyle} scale={scale} />}
  </div>;
}
