"use client";

import { CSSProperties, KeyboardEvent as ReactKeyboardEvent, memo, useCallback, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { captionLines, SubtitleMode, SubtitleStyle } from "./captions";
import { Asset, audioSourceFor, Clip, clipEnd, evaluateVisual, evaluateVolume, placementAt, Project, renderClips, sourceTimeAt, speedAt, Subtitle, textBaseScale } from "./model";
import { measureText, renderText } from "./text";
import { t } from "../i18n";

export type { SubtitleStyle } from "./captions";

function rgba(hex: string, percent: number) {
  const value = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) || 0);
  return `rgba(${r},${g},${b},${percent / 100})`;
}

// Mirrors createAss in electron/video-export.cjs: a background box replaces the outline, as libass BorderStyle 3 does.
type CaptionEdit = { id: number; lang: "zh" | "en" };

function CaptionOverlay({ subtitle, mode, style, scale, editing, syncing, onEdit, onCommit }: { subtitle: Subtitle; mode: SubtitleMode; style: SubtitleStyle; scale: number; editing: CaptionEdit | null; syncing?: string[]; onEdit?: (edit: CaptionEdit | null) => void; onCommit?: (lang: "zh" | "en", text: string) => void }) {
  const lines = captionLines(subtitle, mode, style);
  if (!lines.length) return null;
  const boxed = style.backgroundOpacity > 0;
  const placement: CSSProperties = style.position === "top" ? { top: `${style.offset}%` } : style.position === "middle" ? { top: "50%", transform: "translate(-50%, -50%)" } : { bottom: `${style.offset}%` };
  return <div className="caption-preview" style={{ ...placement, fontFamily: style.fontFamily }}>
    {lines.map((line, index) => {
      const primary = index === 0;
      const size = style.fontSize * scale * (primary || mode !== "both" ? 1 : style.enScale / 100);
      const active = editing?.id === subtitle.id && editing.lang === line.lang;
      const finish = (element: HTMLElement, save: boolean) => {
        const text = (element.innerText ?? "").replace(/\n+$/, "");
        onEdit?.(null);
        if (save && text.trim() && text !== line.text) onCommit?.(line.lang, text);
      };
      return <span key={line.lang} className={`caption-line${primary ? " primary" : ""}${onEdit ? " editable" : ""}${active ? " editing" : ""}${syncing?.includes(`${subtitle.id}:${line.lang}`) ? " syncing" : ""}`}
        title={onEdit && !active ? t("点击编辑字幕") : undefined}
        contentEditable={active ? "plaintext-only" : undefined} suppressContentEditableWarning spellCheck={false}
        ref={(element) => { if (active && element && document.activeElement !== element) { element.focus(); const range = document.createRange(); range.selectNodeContents(element); window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range); } }}
        onPointerDown={(event) => { if (!onEdit) return; event.stopPropagation(); if (!active) { event.preventDefault(); onEdit({ id: subtitle.id, lang: line.lang }); } }}
        onKeyDown={(event: ReactKeyboardEvent<HTMLSpanElement>) => {
          if (!active) return;
          event.stopPropagation();
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.blur(); }
          if (event.key === "Escape") { event.preventDefault(); finish(event.currentTarget, false); }
        }}
        onBlur={(event) => { if (active) finish(event.currentTarget, true); }}
        style={{
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
let audioContext: AudioContext | null = null;
let master: { input: GainNode; analyser: AnalyserNode } | null = null;
const chains = new WeakMap<HTMLMediaElement, AudioChain | null>();

/** Shared output bus; a K-weighted branch feeds the loudness meter (approximating ITU-R BS.1770). */
function masterBus(context: AudioContext) {
  if (master) return master;
  const input = context.createGain();
  input.connect(context.destination);
  const shelf = context.createBiquadFilter();
  shelf.type = "highshelf";
  shelf.frequency.value = 1500;
  shelf.gain.value = 4;
  const highpass = context.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 38;
  const analyser = context.createAnalyser();
  analyser.fftSize = 32768;
  input.connect(shelf).connect(highpass).connect(analyser);
  master = { input, analyser };
  return master;
}

/** Momentary loudness (LUFS over the analyser window) of everything the preview is playing, or null. */
export function readLoudness() {
  if (!master || !audioContext || audioContext.state !== "running") return null;
  const span = Math.min(master.analyser.fftSize, Math.round(audioContext.sampleRate * 0.4));
  const samples = new Float32Array(master.analyser.fftSize);
  master.analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (let index = samples.length - span; index < samples.length; index += 1) sum += samples[index] * samples[index];
  const meanSquare = sum / span;
  // Mono analyser on a stereo mix: +3 dB approximates the two-channel sum.
  return meanSquare > 1e-10 ? -0.691 + 10 * Math.log10(meanSquare) + 3.01 : -70;
}

// Delay-line pitch shifter: two crossfaded read heads sweep through a short buffer, so pitch moves without tempo.
const pitchWorklet = `class DashCutPitch extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: "ratio", defaultValue: 1, minValue: 0.25, maxValue: 4 }]; }
  constructor() { super(); this.size = 8192; this.window = 2048; this.buffers = [new Float32Array(this.size), new Float32Array(this.size)]; this.write = 0; this.phase = 0; }
  read(buffer, delay) { let position = this.write - delay; while (position < 0) position += this.size; const index = Math.floor(position); const fraction = position - index; return buffer[index % this.size] * (1 - fraction) + buffer[(index + 1) % this.size] * fraction; }
  process(inputs, outputs, parameters) {
    const input = inputs[0]; const output = outputs[0]; const ratio = parameters.ratio[0];
    const frames = output[0] ? output[0].length : 128;
    for (let frame = 0; frame < frames; frame += 1) {
      for (let channel = 0; channel < output.length; channel += 1) this.buffers[channel % 2][this.write] = input[channel] ? input[channel][frame] : (input[0] ? input[0][frame] : 0);
      this.phase = (this.phase + (1 - ratio) / this.window + 1) % 1;
      const second = (this.phase + 0.5) % 1;
      const gainA = Math.sin(Math.PI * this.phase); const gainB = Math.sin(Math.PI * second);
      for (let channel = 0; channel < output.length; channel += 1) {
        const buffer = this.buffers[channel % 2];
        output[channel][frame] = gainA * this.read(buffer, this.phase * this.window) + gainB * this.read(buffer, second * this.window);
      }
      this.write = (this.write + 1) % this.size;
    }
    return true;
  }
}
registerProcessor("dashcut-pitch", DashCutPitch);`;
let pitchReady: Promise<boolean> | null = null;
function loadPitch(context: AudioContext) {
  pitchReady ??= context.audioWorklet.addModule(URL.createObjectURL(new Blob([pitchWorklet], { type: "text/javascript" }))).then(() => true, () => false);
  return pitchReady;
}

type AudioChain = {
  gain: GainNode; highpass: BiquadFilterNode; lowpass: BiquadFilterNode; compressor: DynamicsCompressorNode;
  warmth: BiquadFilterNode; presence: BiquadFilterNode; air: BiquadFilterNode;
  dry: GainNode; wet: GainNode; pitch: AudioWorkletNode | null; matrix: GainNode[]; panner: StereoPannerNode;
};

function audioChain(element: HTMLMediaElement) {
  if (chains.has(element)) return chains.get(element)!;
  try {
    audioContext ??= new AudioContext();
    const context = audioContext;
    const filter = (type: BiquadFilterType, frequency: number) => {
      const node = context.createBiquadFilter();
      node.type = type;
      node.frequency.value = frequency;
      return node;
    };
    const source = context.createMediaElementSource(element);
    const highpass = filter("highpass", 10);
    const lowpass = filter("lowpass", 22000);
    const warmth = filter("lowshelf", 200);
    const presence = filter("peaking", 3000);
    const air = filter("highshelf", 8000);
    const compressor = context.createDynamicsCompressor();
    // Pitch runs on a parallel "wet" branch so an unshifted clip has no added latency.
    const dry = context.createGain();
    const wet = context.createGain();
    wet.gain.value = 0;
    const splitter = context.createChannelSplitter(2);
    const merger = context.createChannelMerger(2);
    // Channel layout as a 2×2 gain matrix: [L→L, R→L, L→R, R→R].
    const matrix = [0, 1, 2, 3].map(() => context.createGain());
    const panner = context.createStereoPanner();
    const gain = context.createGain();
    source.connect(highpass).connect(lowpass).connect(warmth).connect(presence).connect(air).connect(compressor);
    compressor.connect(dry).connect(splitter);
    wet.connect(splitter);
    splitter.connect(matrix[0], 0).connect(merger, 0, 0);
    splitter.connect(matrix[1], 1).connect(merger, 0, 0);
    splitter.connect(matrix[2], 0).connect(merger, 0, 1);
    splitter.connect(matrix[3], 1).connect(merger, 0, 1);
    merger.connect(panner).connect(gain).connect(masterBus(context).input);
    const chain: AudioChain = { gain, highpass, lowpass, compressor, warmth, presence, air, dry, wet, pitch: null, matrix, panner };
    void loadPitch(context).then((ok) => {
      if (!ok) return;
      chain.pitch = new AudioWorkletNode(context, "dashcut-pitch", { outputChannelCount: [2] });
      compressor.connect(chain.pitch).connect(wet);
    });
    chains.set(element, chain);
    return chain;
  } catch {
    chains.set(element, null);
    return null;
  }
}

const channelMatrix: Record<ChannelLayout, [number, number, number, number]> = {
  stereo: [1, 0, 0, 1], left: [1, 0, 1, 0], right: [0, 1, 0, 1], mono: [0.5, 0.5, 0.5, 0.5], swap: [0, 1, 1, 0],
};

function applyAudio(element: HTMLMediaElement, clip: Clip, time: number, muted: boolean) {
  const volume = muted ? 0 : evaluateVolume(clip, time);
  const chain = audioChain(element);
  if (!chain) {
    element.volume = Math.max(0, Math.min(1, volume));
    return;
  }
  element.volume = 1;
  const audio = clip.audio;
  const effects = audio.effects;
  const enhance = effects.includes("voice-enhance");
  const level = effects.includes("loudnorm");
  const beautify = effects.includes("voice-beautify");
  chain.highpass.frequency.value = effects.includes("denoise") ? 100 : beautify ? 90 : enhance ? 80 : 10;
  chain.lowpass.frequency.value = effects.includes("denoise") ? 9000 : 22000;
  chain.warmth.gain.value = beautify ? 1.5 : 0;
  chain.presence.gain.value = beautify ? 3 : 0;
  chain.air.gain.value = beautify ? -3 : 0;
  chain.compressor.threshold.value = enhance || level ? -24 : beautify ? -12 : 0;
  chain.compressor.ratio.value = enhance ? 3 : level ? 4 : beautify ? 2 : 1;
  const semitones = audio.pitch ?? 0;
  const shifting = semitones !== 0 && chain.pitch !== null;
  chain.dry.gain.value = shifting ? 0 : 1;
  chain.wet.gain.value = shifting ? 1 : 0;
  chain.pitch?.parameters.get("ratio")?.setValueAtTime(2 ** (semitones / 12), 0);
  channelMatrix[audio.channels ?? "stereo"].forEach((value, index) => { chain.matrix[index].gain.value = value; });
  chain.panner.pan.value = audio.pan ?? 0;
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

/** Where a visual layer sits in the preview frame, in pixels (before rotation). */
function layerGeometry(clip: Clip, asset: Asset, time: number, frame: { width: number; height: number }, ratio: "16:9" | "9:16", titleBox?: { width: number; height: number }) {
  const state = evaluateVisual(clip, time);
  const textBox = titleBox ?? (asset.kind === "text" && clip.text ? measureText(clip.text) : undefined);
  if (textBox) state.scale *= textBaseScale(textBox.width, textBox.height, ratio);
  const mediaWidth = textBox ? textBox.width : asset.width;
  const mediaHeight = textBox ? textBox.height : asset.height;
  const cropWidth = mediaWidth * clip.crop.w;
  const cropHeight = mediaHeight * clip.crop.h;
  const quarter = clip.rotate90 === 90 || clip.rotate90 === 270;
  const fit = Math.min(frame.width / (quarter ? cropHeight : cropWidth), frame.height / (quarter ? cropWidth : cropHeight)) * state.scale;
  const width = (quarter ? cropHeight : cropWidth) * fit;
  const height = (quarter ? cropWidth : cropHeight) * fit;
  const box = { left: frame.width / 2 + state.x * frame.width - width / 2, top: frame.height / 2 + state.y * frame.height - height / 2, width, height };
  return { state, mediaWidth, mediaHeight, cropWidth, cropHeight, fit, box };
}

type Grab = (event: ReactPointerEvent, clip: Clip, mode: "move" | "scale") => void;

const VisualLayer = memo(function VisualLayer({ clip, asset, time, rate, muted, frame, ratio, onGrab }: LayerProps & { onGrab?: Grab }) {
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
  const { state, mediaWidth, mediaHeight, cropWidth, cropHeight, fit, box } = layerGeometry(clip, asset, time, frame, ratio, title?.box);
  const outer: CSSProperties = {
    ...box,
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
  return <div className={`preview-layer${onGrab ? " movable" : ""}`} style={outer} onPointerDown={onGrab ? (event) => onGrab(event, clip, "move") : undefined}>
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
  /** Playable URLs for separated stem files, keyed by file path. */
  stemUrls?: Map<string, string>;
  /** Direct manipulation: selected clips get a box with corner handles; captions edit in place. */
  selection?: string[];
  onSelectClip?: (clipId: string | null) => void;
  onPlacement?: (clipId: string, values: { x?: number; y?: number; scale?: number }, key: string) => void;
  onCaptionChange?: (id: number, lang: "zh" | "en", text: string) => void;
  /** "id:lang" for caption lines being re-translated. */
  syncingCaptions?: string[];
  /** Called when a drag or caption edit starts, so playback can pause. */
  onInteract?: () => void;
};

const snapPixels = 6;

export function Preview({ project, assets, time, rate, muted, ratio, subtitleMode, subtitleStyle, onImport, stemUrls, selection = [], syncingCaptions, onSelectClip, onPlacement, onCaptionChange, onInteract }: PreviewProps) {
  const [captionEdit, setCaptionEdit] = useState<CaptionEdit | null>(null);
  const [guides, setGuides] = useState({ vertical: false, horizontal: false });
  // Handlers read the latest props through a ref so memoised layers keep a stable callback.
  const live = useRef({ time, frame: { width: 640, height: 360 }, onSelectClip, onPlacement, onInteract });
  const frameRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ width: 640, height: 360 });
  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setFrame({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { live.current = { time, frame, onSelectClip, onPlacement, onInteract }; });
  const grab = useCallback<Grab>((event, clip, mode) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const { time: at, frame: size } = live.current;
    live.current.onInteract?.();
    live.current.onSelectClip?.(clip.id);
    const start = placementAt(clip, at);
    const drawn = evaluateVisual(clip, at);
    const bounds = frameRef.current!.getBoundingClientRect();
    const center = { x: bounds.left + size.width / 2 + drawn.x * size.width, y: bounds.top + size.height / 2 + drawn.y * size.height };
    const startDistance = Math.max(4, Math.hypot(event.clientX - center.x, event.clientY - center.y));
    const origin = { x: event.clientX, y: event.clientY };
    const key = `${clip.id}-place-${Date.now()}`;
    let moved = false;
    const move = (next: PointerEvent) => {
      if (!moved && Math.hypot(next.clientX - origin.x, next.clientY - origin.y) < 3) return;
      moved = true;
      if (mode === "scale") {
        const scale = Math.max(0.05, Math.min(10, start.scale * Math.hypot(next.clientX - center.x, next.clientY - center.y) / startDistance));
        return live.current.onPlacement?.(clip.id, { scale: Math.round(scale * 1000) / 1000 }, key);
      }
      let x = start.x + (next.clientX - origin.x) / size.width;
      let y = start.y + (next.clientY - origin.y) / size.height;
      // The layer centre snaps to the frame centre lines; hold Alt to place freely.
      const snapX = !next.altKey && Math.abs(x * size.width) < snapPixels;
      const snapY = !next.altKey && Math.abs(y * size.height) < snapPixels;
      if (snapX) x = 0;
      if (snapY) y = 0;
      setGuides({ vertical: snapX, horizontal: snapY });
      live.current.onPlacement?.(clip.id, { x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 }, key);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      setGuides({ vertical: false, horizontal: false });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  }, []);
  const canPlace = Boolean(onPlacement);
  // Transitions make neighbouring clips overlap, so a track can show more than one clip at once.
  const drawn = useMemo(() => renderClips(project, assets), [assets, project]);
  const active = (trackId: string) => drawn.filter((clip) => clip.trackId === trackId && time >= clip.start && time < clipEnd(clip)).sort((a, b) => a.start - b.start);
  const visualTracks = project.tracks.filter((track) => track.kind === "video" && !track.hidden).reverse();
  // A clip that keeps only its voice or background plays the separated stem instead of its own sound.
  const stemAsset = (clip: Clip, asset: Asset) => {
    const path = audioSourceFor(project, clip, asset);
    const url = path ? stemUrls?.get(path) : undefined;
    return url ? { ...asset, url, kind: "audio" as const } : null;
  };
  const layers = visualTracks.flatMap((track) => active(track.id).flatMap((clip) => {
    const asset = assets.get(clip.assetId);
    return asset && asset.kind !== "audio" ? [{ clip, asset, muted: muted || track.muted || Boolean(stemAsset(clip, asset)), locked: track.locked }] : [];
  }));
  const selected = layers.filter((layer) => selection.includes(layer.clip.id) && !layer.locked);
  const stemLayers = visualTracks.flatMap((track) => active(track.id).flatMap((clip) => {
    const asset = assets.get(clip.assetId);
    const stem = asset && stemAsset(clip, asset);
    return stem ? [{ clip, asset: stem, muted: muted || track.muted }] : [];
  }));
  const audioLayers = [...stemLayers, ...project.tracks.filter((track) => track.kind === "audio").flatMap((track) => active(track.id).flatMap((clip) => {
    const asset = assets.get(clip.assetId);
    if (!asset) return [];
    return [{ clip, asset: stemAsset(clip, asset) ?? asset, muted: muted || track.muted }];
  }))];
  const subtitle: Subtitle | undefined = project.subtitles.find((item) => time >= item.start && time < item.end);
  const scale = frame.height / 1080;
  const editingCaption = captionEdit && subtitle?.id === captionEdit.id ? captionEdit : null;
  return <div ref={frameRef} className={`video-frame ratio-${ratio.replace(":", "-")}`} onPointerDown={(event) => { if (onSelectClip && event.button === 0 && layers.length) onSelectClip(null); }}>
    {layers.map(({ clip, asset, muted: layerMuted, locked }) => <VisualLayer key={clip.id} clip={clip} asset={asset} time={time} rate={rate} muted={layerMuted} frame={frame} ratio={ratio} onGrab={locked || !canPlace ? undefined : grab} />)}
    {canPlace && selected.map(({ clip, asset }) => {
      const { state, box } = layerGeometry(clip, asset, time, frame, ratio);
      return <div key={`select-${clip.id}`} className="preview-selection" style={{ ...box, transform: `rotate(${state.rotation}deg)` }}>
        {(["nw", "ne", "sw", "se"] as const).map((corner) => <i key={corner} className={`preview-handle ${corner}`} title={t("拖动缩放")} onPointerDown={(event) => grab(event, clip, "scale")} />)}
      </div>;
    })}
    {guides.vertical && <i className="preview-guide vertical" />}
    {guides.horizontal && <i className="preview-guide horizontal" />}
    {audioLayers.map(({ clip, asset, muted: layerMuted }) => <AudioLayer key={`${clip.id}-${asset.url}`} clip={clip} asset={asset} time={time} rate={rate} muted={layerMuted} />)}
    {!project.clips.length && <button className="empty-stage" onClick={onImport}><span>＋</span><strong>{t("导入素材开始创作")}</strong><small>{t("导入后从左侧素材库拖到时间轴")}</small></button>}
    {subtitle && <CaptionOverlay subtitle={subtitle} mode={subtitleMode} style={subtitleStyle} scale={scale} editing={editingCaption} syncing={syncingCaptions}
      onEdit={onCaptionChange ? (edit) => { if (edit) onInteract?.(); setCaptionEdit(edit); } : undefined}
      onCommit={(lang, text) => onCaptionChange?.(subtitle.id, lang, text)} />}
  </div>;
}
