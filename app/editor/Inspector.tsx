"use client";

import { memo, PointerEvent as ReactPointerEvent, useState } from "react";
import { Icon } from "./icons";
import { Asset, Clip, clipDuration, defaultClipSettings, TextStyle, TransitionType } from "./model";
import { evaluateKeyframes, keyframeAt, removeKeyframe, setKeyframe, SpeedPoint, speedCurvePresets } from "./motion";
import { defaultTextStyle } from "./text";

export type InspectorTab = "text" | "picture" | "audio" | "speed" | "animation" | "adjust" | "ai";
type Change = (patch: Partial<Clip>, key: string) => void;
type KeyframeControl = { has: boolean; at: boolean; onToggle: () => void; onPrev: (() => void) | null; onNext: (() => void) | null };

const tabLabels: Record<InspectorTab, string> = { text: "文本", picture: "画面", audio: "音频", speed: "变速", animation: "动画", adjust: "调整", ai: "AI 效果" };
const easingLabels: Record<KeyframeEasing, string> = { linear: "线性", "ease-in": "缓入", "ease-out": "缓出", "ease-in-out": "缓入缓出", hold: "定格" };
const transitionLabels: Array<[TransitionType | "none", string]> = [["none", "无"], ["crossfade", "叠化"], ["dip", "闪黑"], ["wipe", "擦除"], ["slide", "推移"]];
const fonts: Array<[string, string]> = [['"PingFang SC", "Microsoft YaHei", Arial, sans-serif', "系统黑体"], ['Georgia, "Songti SC", serif', "衬线宋体"], ['"Arial Black", "PingFang SC", sans-serif', "醒目粗体"], ['"Kaiti SC", "STKaiti", serif', "楷体"], ['"Courier New", monospace', "等宽"]];
const animationTypes: AnimationType[] = ["none", "fade", "slide-left", "slide-right", "slide-up", "slide-down", "zoom-in", "zoom-out", "wipe-right", "wipe-left"];
function animationLabel(type: AnimationType, entering: boolean) {
  const labels: Record<AnimationType, [string, string]> = {
    none: ["无", "无"], fade: ["渐显", "渐隐"], "slide-left": ["从左滑入", "向左滑出"], "slide-right": ["从右滑入", "向右滑出"],
    "slide-up": ["从上滑入", "向上滑出"], "slide-down": ["从下滑入", "向下滑出"], "zoom-in": ["放大进入", "缩小退出"], "zoom-out": ["缩小进入", "放大退出"],
    "wipe-right": ["向右擦入", "向左擦出"], "wipe-left": ["向左擦入", "向右擦出"],
  };
  return labels[type][entering ? 0 : 1];
}
const visualEffects: Array<{ id: VisualEffect; label: string; note: string }> = [
  { id: "beauty", label: "智能美颜", note: "双边滤波磨皮" },
  { id: "denoise", label: "画面降噪", note: "时域降噪，导出生效" },
  { id: "sharpen", label: "智能锐化", note: "增强细节" },
  { id: "chroma-key", label: "色度抠图", note: "绿幕/蓝幕抠像" },
  { id: "bw", label: "黑白", note: "去色" },
  { id: "vintage", label: "复古", note: "暖褐色调" },
  { id: "vignette", label: "暗角", note: "四周压暗" },
  { id: "blur", label: "模糊", note: "高斯模糊" },
];
const audioEffects: Array<{ id: AudioEffect; label: string; note: string }> = [
  { id: "denoise", label: "智能降噪", note: "抑制底噪与嘶声" },
  { id: "voice-enhance", label: "人声增强", note: "低切 + 压缩" },
  { id: "loudnorm", label: "响度统一", note: "EBU R128 标准化" },
];

function Slider({ label, value, min, max, step, format, onChange, onReset, keyframe }: { label: string; value: number; min: number; max: number; step: number; format: (value: number) => string; onChange: (value: number) => void; onReset: () => void; keyframe?: KeyframeControl }) {
  return <label className={`inspector-slider${keyframe ? " keyed" : ""}`}>
    <span>{label}</span>
    <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    <b>{format(value)}</b>
    <button type="button" title="重置" onClick={(event) => { event.preventDefault(); onReset(); }}><Icon name="reset" size={12} /></button>
    {keyframe && <span className="keyframe-buttons" onClick={(event) => event.preventDefault()}>
      <button type="button" title="上一个关键帧" disabled={!keyframe.onPrev} onClick={() => keyframe.onPrev?.()}>‹</button>
      <button type="button" className={`diamond${keyframe.at ? " on" : keyframe.has ? " has" : ""}`} title={keyframe.at ? "删除此处关键帧" : "在播放头处添加关键帧"} onClick={keyframe.onToggle}>◆</button>
      <button type="button" title="下一个关键帧" disabled={!keyframe.onNext} onClick={() => keyframe.onNext?.()}>›</button>
    </span>}
  </label>;
}

/** Draggable speed-curve editor; y is logarithmic from 0.1× to 10×. */
function CurveEditor({ points, onChange }: { points: SpeedPoint[]; onChange: (points: SpeedPoint[]) => void }) {
  const [drag, setDrag] = useState<number | null>(null);
  const width = 240;
  const height = 90;
  const toY = (speed: number) => height / 2 - (Math.log10(speed) / 1) * (height / 2 - 6);
  const fromY = (y: number) => Math.min(10, Math.max(0.1, 10 ** (((height / 2 - y) / (height / 2 - 6)) * 1)));
  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (drag === null) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const y = ((event.clientY - rect.top) / rect.height) * height;
    onChange(points.map((point, index) => index === drag ? { ...point, y: Number(fromY(y).toFixed(2)) } : point));
  };
  const path = points.map((point, index) => `${index ? "L" : "M"}${(point.x * width).toFixed(1)} ${toY(point.y).toFixed(1)}`).join(" ");
  return <svg className="curve-editor" viewBox={`0 0 ${width} ${height}`} onPointerMove={move} onPointerUp={() => setDrag(null)} onPointerLeave={() => setDrag(null)}>
    <line x1="0" x2={width} y1={toY(1)} y2={toY(1)} className="curve-baseline" />
    <path d={path} />
    {points.map((point, index) => <circle key={index} cx={point.x * width} cy={toY(point.y)} r="5" onPointerDown={(event) => { event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId); setDrag(index); }}><title>{point.y}×</title></circle>)}
  </svg>;
}

const percent = (value: number) => `${Math.round(value * 100)}%`;
const signed = (value: number) => `${value > 0 ? "+" : ""}${Math.round(value * 100)}`;

type InspectorProps = {
  clip: Clip | null; asset: Asset | null; tab: InspectorTab; time: number; transitionAllowed: boolean;
  onTab: (tab: InspectorTab) => void; onChange: Change; onCrop: () => void; onSeek: (time: number) => void;
};

export const Inspector = memo(function Inspector({ clip, asset, tab: requestedTab, time, transitionAllowed, onTab, onChange, onCrop, onSeek }: InspectorProps) {
  const [speedInput, setSpeedInput] = useState("");
  const defaults = defaultClipSettings();
  const isText = asset?.kind === "text";
  const isVisual = asset ? asset.kind !== "audio" : false;
  const hasSound = asset ? asset.hasAudio && clip?.freezeAt === null : false;
  const tabs: InspectorTab[] = isText ? ["text", "picture", "animation"] : ["picture", "audio", "speed", "animation", "adjust", "ai"];
  const tab = tabs.includes(requestedTab) ? requestedTab : tabs[0];
  const supports: Record<InspectorTab, boolean> = {
    text: isText, picture: isVisual, audio: hasSound, speed: Boolean(asset && asset.kind !== "image" && !isText && clip?.freezeAt === null), animation: isVisual, adjust: isVisual, ai: Boolean(asset),
  };
  const local = clip ? Math.max(0, Math.min(clipDuration(clip), time - clip.start)) : 0;

  // A property with keyframes is edited at the playhead; without them the static value changes.
  function keyed(property: "x" | "y" | "scale" | "rotation" | "opacity") {
    const points = clip!.keyframes?.[property];
    const value = evaluateKeyframes(points, local, clip!.transform[property]);
    const sorted = points ?? [];
    const previous = [...sorted].reverse().find((point) => point.time < local - 0.01);
    const next = sorted.find((point) => point.time > local + 0.01);
    const setPoints = (next: KeyframePoint[] | undefined, key: string) => onChange({ keyframes: { ...clip!.keyframes, [property]: next } }, key);
    return {
      value,
      change: (input: number) => points ? setPoints(setKeyframe(points, local, input), `kf-${property}`) : onChange({ transform: { ...clip!.transform, [property]: input } }, property),
      reset: (base: number) => onChange({ keyframes: { ...clip!.keyframes, [property]: undefined }, transform: { ...clip!.transform, [property]: base } }, `${property}-reset`),
      keyframe: {
        has: Boolean(points?.length),
        at: Boolean(keyframeAt(points, local)),
        onToggle: () => setPoints(keyframeAt(points, local) ? removeKeyframe(points, local) : setKeyframe(points, local, value), `kf-toggle-${property}`),
        onPrev: previous ? () => onSeek(clip!.start + previous.time) : null,
        onNext: next ? () => onSeek(clip!.start + next.time) : null,
      },
    };
  }

  function setEasingAtPlayhead(easing: KeyframeEasing) {
    const keyframes = Object.fromEntries(Object.entries(clip!.keyframes ?? {}).map(([key, points]) => [key, points?.map((point) => Math.abs(point.time - local) < 1 / 120 ? { ...point, easing } : point)]));
    const volumeKeyframes = clip!.audio.volumeKeyframes?.map((point) => Math.abs(point.time - local) < 1 / 120 ? { ...point, easing } : point);
    onChange({ keyframes, audio: { ...clip!.audio, volumeKeyframes } }, "easing");
  }
  const easingHere = clip && [...Object.values(clip.keyframes ?? {}), clip.audio.volumeKeyframes].map((points) => keyframeAt(points, local)).find(Boolean);
  const setText = (patch: Partial<TextStyle>, key: string) => onChange({ text: { ...defaultTextStyle, ...clip!.text, ...patch } }, `text-${key}`);

  return <aside className="inspector">
    <nav className="inspector-tabs" style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }}>{tabs.map((key) => <button key={key} className={tab === key ? "active" : ""} onClick={() => onTab(key)}>{tabLabels[key]}</button>)}</nav>
    <div className="inspector-body">
      {!clip || !asset ? <div className="inspector-empty"><Icon name="pointer" size={22} /><b>选择时间轴上的片段</b><small>在这里调整画面、音频、变速、动画、色彩与 AI 效果，预览和导出同步生效。</small></div>
        : !supports[tab] ? <div className="inspector-empty"><b>当前片段不支持「{tabLabels[tab]}」</b><small>{tab === "audio" ? "该素材没有音轨，或是定格画面。" : tab === "speed" ? "图片和定格画面没有时间流速，可直接拖动边缘调整时长。" : "音频片段只支持音频、变速和 AI 音频效果。"}</small></div>
          : <>
            <div className="inspector-clip"><span>{isText ? "文本" : asset.kind === "audio" ? "音频" : asset.kind === "video" ? (clip.freezeAt !== null ? "定格" : "视频") : asset.kind === "gif" ? "动图" : "图片"}</span><strong>{isText ? clip.text?.content.split("\n")[0] : asset.name}</strong><small>{clipDuration(clip).toFixed(2)} 秒</small></div>
            {tab === "text" && <section className="text-editor">
              <textarea rows={3} value={clip.text?.content ?? ""} onChange={(event) => setText({ content: event.target.value }, "content")} placeholder="输入文字，回车换行" />
              <label className="text-row">字体<select value={clip.text?.fontFamily} onChange={(event) => setText({ fontFamily: event.target.value }, "font")}>{fonts.map(([value, label]) => <option key={label} value={value}>{label}</option>)}</select></label>
              <Slider label="字号" value={clip.text?.fontSize ?? 72} min={16} max={240} step={1} format={(value) => `${Math.round(value)}px`} onChange={(fontSize) => setText({ fontSize }, "size")} onReset={() => setText({ fontSize: 72 }, "size-reset")} />
              <div className="text-toggles">
                <button className={clip.text?.bold ? "active" : ""} onClick={() => setText({ bold: !clip.text?.bold }, "bold")}><b>B</b></button>
                <button className={clip.text?.italic ? "active" : ""} onClick={() => setText({ italic: !clip.text?.italic }, "italic")}><i>I</i></button>
                {(["left", "center", "right"] as const).map((align) => <button key={align} className={clip.text?.align === align ? "active" : ""} onClick={() => setText({ align }, "align")}>{align === "left" ? "左" : align === "center" ? "中" : "右"}</button>)}
                <button className={clip.text?.shadow ? "active" : ""} onClick={() => setText({ shadow: !clip.text?.shadow }, "shadow")}>阴影</button>
              </div>
              <div className="text-colors">
                <label>文字<input type="color" value={clip.text?.color} onChange={(event) => setText({ color: event.target.value }, "color")} /></label>
                <label>描边<input type="color" value={clip.text?.strokeColor} onChange={(event) => setText({ strokeColor: event.target.value }, "stroke-color")} /></label>
                <label>背景<input type="color" value={clip.text?.backgroundColor} onChange={(event) => setText({ backgroundColor: event.target.value }, "bg-color")} /></label>
              </div>
              <Slider label="描边" value={clip.text?.strokeWidth ?? 0} min={0} max={16} step={1} format={(value) => `${value}px`} onChange={(strokeWidth) => setText({ strokeWidth }, "stroke")} onReset={() => setText({ strokeWidth: 0 }, "stroke-reset")} />
              <Slider label="背景" value={clip.text?.backgroundOpacity ?? 0} min={0} max={1} step={0.01} format={percent} onChange={(backgroundOpacity) => setText({ backgroundOpacity }, "bg")} onReset={() => setText({ backgroundOpacity: 0 }, "bg-reset")} />
            </section>}
            {tab === "picture" && (() => {
              const scale = keyed("scale"); const x = keyed("x"); const y = keyed("y"); const rotation = keyed("rotation"); const opacity = keyed("opacity");
              return <section>
              <h4>位置与大小 <small>◆ 在播放头处打关键帧</small></h4>
              <Slider label="缩放" value={scale.value} min={0.1} max={4} step={0.01} format={percent} onChange={scale.change} onReset={() => scale.reset(1)} keyframe={scale.keyframe} />
              <Slider label="位置 X" value={x.value} min={-1} max={1} step={0.005} format={signed} onChange={x.change} onReset={() => x.reset(0)} keyframe={x.keyframe} />
              <Slider label="位置 Y" value={y.value} min={-1} max={1} step={0.005} format={signed} onChange={y.change} onReset={() => y.reset(0)} keyframe={y.keyframe} />
              <Slider label="旋转" value={rotation.value} min={-180} max={180} step={1} format={(value) => `${Math.round(value)}°`} onChange={rotation.change} onReset={() => rotation.reset(0)} keyframe={rotation.keyframe} />
              <Slider label="不透明度" value={opacity.value} min={0} max={1} step={0.01} format={percent} onChange={opacity.change} onReset={() => opacity.reset(1)} keyframe={opacity.keyframe} />
              {easingHere && <label className="easing-row">关键帧曲线<select value={easingHere.easing} onChange={(event) => setEasingAtPlayhead(event.target.value as KeyframeEasing)}>{(Object.keys(easingLabels) as KeyframeEasing[]).map((easing) => <option key={easing} value={easing}>{easingLabels[easing]}</option>)}</select></label>}
              <h4>镜像与裁剪</h4>
              <div className="inspector-buttons">
                <button className={clip.mirror ? "active" : ""} onClick={() => onChange({ mirror: !clip.mirror }, "mirror")}><Icon name="mirror" />镜像</button>
                <button onClick={() => onChange({ rotate90: ((clip.rotate90 + 90) % 360) as Clip["rotate90"] }, "rotate90")}><Icon name="rotate" />旋转 90°</button>
                <button onClick={onCrop}><Icon name="crop" />裁剪</button>
              </div>
              <button className="reset-section" onClick={() => onChange({ transform: defaults.transform, keyframes: undefined, mirror: false, rotate90: 0, crop: defaults.crop }, "picture-reset")}>重置画面（含关键帧）</button>
            </section>; })()}
            {tab === "audio" && <section>
              <h4>基础</h4>
              {(() => {
                const points = clip.audio.volumeKeyframes;
                const value = evaluateKeyframes(points, local, clip.audio.volume);
                const previous = [...(points ?? [])].reverse().find((point) => point.time < local - 0.01);
                const next = (points ?? []).find((point) => point.time > local + 0.01);
                const setPoints = (volumeKeyframes: KeyframePoint[] | undefined, key: string) => onChange({ audio: { ...clip.audio, volumeKeyframes } }, key);
                return <Slider label="音量" value={value} min={0} max={2} step={0.01} format={percent}
                  onChange={(volume) => points ? setPoints(setKeyframe(points, local, volume), "kf-volume") : onChange({ audio: { ...clip.audio, volume } }, "volume")}
                  onReset={() => onChange({ audio: { ...clip.audio, volume: 1, volumeKeyframes: undefined } }, "volume-reset")}
                  keyframe={{ has: Boolean(points?.length), at: Boolean(keyframeAt(points, local)), onToggle: () => setPoints(keyframeAt(points, local) ? removeKeyframe(points, local) : setKeyframe(points, local, value), "kf-toggle-volume"), onPrev: previous ? () => onSeek(clip.start + previous.time) : null, onNext: next ? () => onSeek(clip.start + next.time) : null }} />;
              })()}
              <Slider label="淡入" value={clip.audio.fadeIn} min={0} max={Math.min(10, clipDuration(clip))} step={0.1} format={(value) => `${value.toFixed(1)}s`} onChange={(fadeIn) => onChange({ audio: { ...clip.audio, fadeIn } }, "fadeIn")} onReset={() => onChange({ audio: { ...clip.audio, fadeIn: 0 } }, "fadeIn-reset")} />
              <Slider label="淡出" value={clip.audio.fadeOut} min={0} max={Math.min(10, clipDuration(clip))} step={0.1} format={(value) => `${value.toFixed(1)}s`} onChange={(fadeOut) => onChange({ audio: { ...clip.audio, fadeOut } }, "fadeOut")} onReset={() => onChange({ audio: { ...clip.audio, fadeOut: 0 } }, "fadeOut-reset")} />
              <label className="inspector-toggle"><input type="checkbox" checked={clip.audio.muted} onChange={(event) => onChange({ audio: { ...clip.audio, muted: event.target.checked } }, "muted")} />静音此片段</label>
              <p className="inspector-note">音量最高 200%，预览与导出一致；音频效果在预览中为近似效果。</p>
            </section>}
            {tab === "speed" && <section>
              <h4>常规变速</h4>
              <Slider label="倍速" value={Math.log10(clip.speed)} min={-1} max={1} step={0.01} format={() => `${clip.speed.toFixed(2)}×`} onChange={(value) => onChange({ speed: Number((10 ** value).toFixed(2)) }, "speed")} onReset={() => onChange({ speed: 1 }, "speed-reset")} />
              <div className="speed-presets">{[0.25, 0.5, 1, 1.5, 2, 3, 5].map((value) => <button key={value} className={clip.speed === value ? "active" : ""} onClick={() => onChange({ speed: value }, "speed-preset")}>{value}×</button>)}</div>
              <label className="speed-input">自定义倍速<input type="number" min="0.1" max="10" step="0.05" placeholder={clip.speed.toString()} value={speedInput} onChange={(event) => setSpeedInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { const value = Number(speedInput); if (value >= 0.1 && value <= 10) onChange({ speed: value }, "speed-input"); setSpeedInput(""); } }} /></label>
              <label className="inspector-toggle"><input type="checkbox" checked={clip.reverse} onChange={(event) => onChange({ reverse: event.target.checked }, "reverse")} />倒放</label>
              <h4>曲线变速</h4>
              <div className="curve-presets">
                <button className={!clip.speedCurve ? "active" : ""} onClick={() => onChange({ speedCurve: undefined }, "curve-none")}>无</button>
                {speedCurvePresets.map((preset) => <button key={preset.id} className={JSON.stringify(clip.speedCurve) === JSON.stringify(preset.points) ? "active" : ""} onClick={() => onChange({ speedCurve: preset.points }, "curve-preset")}>{preset.label}</button>)}
              </div>
              {clip.speedCurve && <CurveEditor points={clip.speedCurve} onChange={(speedCurve) => onChange({ speedCurve }, "curve-edit")} />}
              <p className="inspector-note">变速后时长 {clipDuration(clip).toFixed(2)} 秒（原素材 {(clip.out - clip.in).toFixed(2)} 秒）。声音随倍速保持音调。</p>
            </section>}
            {tab === "animation" && <section>
              {transitionAllowed && <div className="animation-group">
                <h4>转场（到下一段）</h4>
                <div className="animation-grid transitions">{transitionLabels.map(([type, label]) => <button key={type} className={(clip.transitionOut?.type ?? "none") === type ? "active" : ""} onClick={() => onChange({ transitionOut: type === "none" ? undefined : { type, duration: clip.transitionOut?.duration ?? 0.8 } }, "transition")}><i className={`anim-swatch ${type === "crossfade" ? "fade" : type === "wipe" ? "wipe-right" : type === "slide" ? "slide-right" : type}`} />{label}</button>)}</div>
                {clip.transitionOut && <Slider label="时长" value={clip.transitionOut.duration} min={0.2} max={2} step={0.1} format={(value) => `${value.toFixed(1)}s`} onChange={(duration) => onChange({ transitionOut: { ...clip.transitionOut!, duration } }, "transition-duration")} onReset={() => onChange({ transitionOut: { ...clip.transitionOut!, duration: 0.8 } }, "transition-reset")} />}
                <p className="inspector-note">转场会使用两段素材在剪辑点前后多出的画面；素材不够长时自动改为闪黑。</p>
              </div>}
              {(["animationIn", "animationOut"] as const).map((key) => <div key={key} className="animation-group">
                <h4>{key === "animationIn" ? "入场动画" : "出场动画"}</h4>
                <div className="animation-grid">{animationTypes.map((type) => <button key={type} className={clip[key].type === type ? "active" : ""} onClick={() => onChange({ [key]: { ...clip[key], type } }, `${key}-type`)}><i className={`anim-swatch ${type}`} />{animationLabel(type, key === "animationIn")}</button>)}</div>
                <Slider label="时长" value={clip[key].duration} min={0.1} max={Math.max(0.2, Math.min(5, clipDuration(clip)))} step={0.1} format={(value) => `${value.toFixed(1)}s`} onChange={(duration) => onChange({ [key]: { ...clip[key], duration } }, `${key}-duration`)} onReset={() => onChange({ [key]: { ...clip[key], duration: 0.5 } }, `${key}-reset`)} />
              </div>)}
            </section>}
            {tab === "adjust" && <section>
              <h4>色彩调节</h4>
              <Slider label="亮度" value={clip.adjust.brightness} min={-1} max={1} step={0.01} format={signed} onChange={(brightness) => onChange({ adjust: { ...clip.adjust, brightness } }, "brightness")} onReset={() => onChange({ adjust: { ...clip.adjust, brightness: 0 } }, "brightness-reset")} />
              <Slider label="对比度" value={clip.adjust.contrast} min={0} max={2} step={0.01} format={percent} onChange={(contrast) => onChange({ adjust: { ...clip.adjust, contrast } }, "contrast")} onReset={() => onChange({ adjust: { ...clip.adjust, contrast: 1 } }, "contrast-reset")} />
              <Slider label="饱和度" value={clip.adjust.saturation} min={0} max={3} step={0.01} format={percent} onChange={(saturation) => onChange({ adjust: { ...clip.adjust, saturation } }, "saturation")} onReset={() => onChange({ adjust: { ...clip.adjust, saturation: 1 } }, "saturation-reset")} />
              <Slider label="色温" value={clip.adjust.temperature} min={-1} max={1} step={0.01} format={signed} onChange={(temperature) => onChange({ adjust: { ...clip.adjust, temperature } }, "temperature")} onReset={() => onChange({ adjust: { ...clip.adjust, temperature: 0 } }, "temperature-reset")} />
              <button className="reset-section" onClick={() => onChange({ adjust: defaults.adjust }, "adjust-reset")}>重置调节</button>
            </section>}
            {tab === "ai" && <section>
              {isVisual && <><h4>画面效果</h4>
                <div className="effect-toggles">{visualEffects.map((effect) => <button key={effect.id} className={clip.effects.includes(effect.id) ? "active" : ""} onClick={() => onChange({ effects: clip.effects.includes(effect.id) ? clip.effects.filter((item) => item !== effect.id) : [...clip.effects, effect.id] }, `effect-${effect.id}`)}><b>{effect.label}</b><small>{effect.note}</small></button>)}</div>
                {clip.effects.includes("chroma-key") && <div className="chroma-settings">
                  <label>抠除颜色<input type="color" value={clip.chromaKey.color} onChange={(event) => onChange({ chromaKey: { ...clip.chromaKey, color: event.target.value } }, "chroma-color")} /></label>
                  <Slider label="相似度" value={clip.chromaKey.similarity} min={0.05} max={0.6} step={0.01} format={percent} onChange={(similarity) => onChange({ chromaKey: { ...clip.chromaKey, similarity } }, "chroma-similarity")} onReset={() => onChange({ chromaKey: { ...clip.chromaKey, similarity: 0.3 } }, "chroma-reset")} />
                </div>}
                <p className="inspector-note">画面降噪和美颜在预览中为近似效果，导出时使用 FFmpeg 精确处理。</p></>}
              {hasSound && <><h4>音频效果</h4>
                <div className="effect-toggles">{audioEffects.map((effect) => <button key={effect.id} className={clip.audio.effects.includes(effect.id) ? "active" : ""} onClick={() => onChange({ audio: { ...clip.audio, effects: clip.audio.effects.includes(effect.id) ? clip.audio.effects.filter((item) => item !== effect.id) : [...clip.audio.effects, effect.id] } }, `audio-effect-${effect.id}`)}><b>{effect.label}</b><small>{effect.note}</small></button>)}</div>
                <p className="inspector-note">音频效果在导出时生效。</p></>}
            </section>}
          </>}
    </div>
  </aside>;
});
