"use client";

import { memo, useState } from "react";
import { Icon } from "./icons";
import { Asset, Clip, clipDuration, defaultClipSettings } from "./model";

export type InspectorTab = "picture" | "audio" | "speed" | "animation" | "adjust" | "ai";
type Change = (patch: Partial<Clip>, key: string) => void;

const tabLabels: Record<InspectorTab, string> = { picture: "画面", audio: "音频", speed: "变速", animation: "动画", adjust: "调整", ai: "AI 效果" };
const animationTypes: AnimationType[] = ["none", "fade", "slide-left", "slide-right", "slide-up", "slide-down", "zoom-in", "zoom-out"];
function animationLabel(type: AnimationType, entering: boolean) {
  const labels: Record<AnimationType, [string, string]> = {
    none: ["无", "无"], fade: ["渐显", "渐隐"], "slide-left": ["从左滑入", "向左滑出"], "slide-right": ["从右滑入", "向右滑出"],
    "slide-up": ["从上滑入", "向上滑出"], "slide-down": ["从下滑入", "向下滑出"], "zoom-in": ["放大进入", "缩小退出"], "zoom-out": ["缩小进入", "放大退出"],
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

function Slider({ label, value, min, max, step, format, onChange, onReset }: { label: string; value: number; min: number; max: number; step: number; format: (value: number) => string; onChange: (value: number) => void; onReset: () => void }) {
  return <label className="inspector-slider">
    <span>{label}</span>
    <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    <b>{format(value)}</b>
    <button type="button" title="重置" onClick={(event) => { event.preventDefault(); onReset(); }}><Icon name="reset" size={12} /></button>
  </label>;
}

const percent = (value: number) => `${Math.round(value * 100)}%`;
const signed = (value: number) => `${value > 0 ? "+" : ""}${Math.round(value * 100)}`;

type InspectorProps = { clip: Clip | null; asset: Asset | null; tab: InspectorTab; onTab: (tab: InspectorTab) => void; onChange: Change; onCrop: () => void };

export const Inspector = memo(function Inspector({ clip, asset, tab, onTab, onChange, onCrop }: InspectorProps) {
  const [speedInput, setSpeedInput] = useState("");
  const defaults = defaultClipSettings();
  const isVisual = asset ? asset.kind !== "audio" : false;
  const hasSound = asset ? asset.hasAudio && clip?.freezeAt === null : false;
  const supports: Record<InspectorTab, boolean> = {
    picture: isVisual, audio: hasSound, speed: Boolean(asset && asset.kind !== "image" && clip?.freezeAt === null), animation: isVisual, adjust: isVisual, ai: Boolean(asset),
  };
  return <aside className="inspector">
    <nav className="inspector-tabs">{(Object.keys(tabLabels) as InspectorTab[]).map((key) => <button key={key} className={tab === key ? "active" : ""} onClick={() => onTab(key)}>{tabLabels[key]}</button>)}</nav>
    <div className="inspector-body">
      {!clip || !asset ? <div className="inspector-empty"><Icon name="pointer" size={22} /><b>选择时间轴上的片段</b><small>在这里调整画面、音频、变速、动画、色彩与 AI 效果，预览和导出同步生效。</small></div>
        : !supports[tab] ? <div className="inspector-empty"><b>当前片段不支持「{tabLabels[tab]}」</b><small>{tab === "audio" ? "该素材没有音轨，或是定格画面。" : tab === "speed" ? "图片和定格画面没有时间流速，可直接拖动边缘调整时长。" : "音频片段只支持音频、变速和 AI 音频效果。"}</small></div>
          : <>
            <div className="inspector-clip"><span>{asset.kind === "audio" ? "音频" : asset.kind === "video" ? (clip.freezeAt !== null ? "定格" : "视频") : asset.kind === "gif" ? "动图" : "图片"}</span><strong>{asset.name}</strong><small>{clipDuration(clip).toFixed(2)} 秒</small></div>
            {tab === "picture" && <section>
              <h4>位置与大小</h4>
              <Slider label="缩放" value={clip.transform.scale} min={0.1} max={4} step={0.01} format={percent} onChange={(scale) => onChange({ transform: { ...clip.transform, scale } }, "scale")} onReset={() => onChange({ transform: { ...clip.transform, scale: 1 } }, "scale-reset")} />
              <Slider label="位置 X" value={clip.transform.x} min={-1} max={1} step={0.005} format={signed} onChange={(x) => onChange({ transform: { ...clip.transform, x } }, "x")} onReset={() => onChange({ transform: { ...clip.transform, x: 0 } }, "x-reset")} />
              <Slider label="位置 Y" value={clip.transform.y} min={-1} max={1} step={0.005} format={signed} onChange={(y) => onChange({ transform: { ...clip.transform, y } }, "y")} onReset={() => onChange({ transform: { ...clip.transform, y: 0 } }, "y-reset")} />
              <Slider label="旋转" value={clip.transform.rotation} min={-180} max={180} step={1} format={(value) => `${Math.round(value)}°`} onChange={(rotation) => onChange({ transform: { ...clip.transform, rotation } }, "rotation")} onReset={() => onChange({ transform: { ...clip.transform, rotation: 0 } }, "rotation-reset")} />
              <Slider label="不透明度" value={clip.transform.opacity} min={0} max={1} step={0.01} format={percent} onChange={(opacity) => onChange({ transform: { ...clip.transform, opacity } }, "opacity")} onReset={() => onChange({ transform: { ...clip.transform, opacity: 1 } }, "opacity-reset")} />
              <h4>镜像与裁剪</h4>
              <div className="inspector-buttons">
                <button className={clip.mirror ? "active" : ""} onClick={() => onChange({ mirror: !clip.mirror }, "mirror")}><Icon name="mirror" />镜像</button>
                <button onClick={() => onChange({ rotate90: ((clip.rotate90 + 90) % 360) as Clip["rotate90"] }, "rotate90")}><Icon name="rotate" />旋转 90°</button>
                <button onClick={onCrop}><Icon name="crop" />裁剪</button>
              </div>
              <button className="reset-section" onClick={() => onChange({ transform: defaults.transform, mirror: false, rotate90: 0, crop: defaults.crop }, "picture-reset")}>重置画面</button>
            </section>}
            {tab === "audio" && <section>
              <h4>基础</h4>
              <Slider label="音量" value={clip.audio.volume} min={0} max={2} step={0.01} format={percent} onChange={(volume) => onChange({ audio: { ...clip.audio, volume } }, "volume")} onReset={() => onChange({ audio: { ...clip.audio, volume: 1 } }, "volume-reset")} />
              <Slider label="淡入" value={clip.audio.fadeIn} min={0} max={Math.min(10, clipDuration(clip))} step={0.1} format={(value) => `${value.toFixed(1)}s`} onChange={(fadeIn) => onChange({ audio: { ...clip.audio, fadeIn } }, "fadeIn")} onReset={() => onChange({ audio: { ...clip.audio, fadeIn: 0 } }, "fadeIn-reset")} />
              <Slider label="淡出" value={clip.audio.fadeOut} min={0} max={Math.min(10, clipDuration(clip))} step={0.1} format={(value) => `${value.toFixed(1)}s`} onChange={(fadeOut) => onChange({ audio: { ...clip.audio, fadeOut } }, "fadeOut")} onReset={() => onChange({ audio: { ...clip.audio, fadeOut: 0 } }, "fadeOut-reset")} />
              <label className="inspector-toggle"><input type="checkbox" checked={clip.audio.muted} onChange={(event) => onChange({ audio: { ...clip.audio, muted: event.target.checked } }, "muted")} />静音此片段</label>
              <p className="inspector-note">音量超过 100% 仅在导出时放大，预览最高按 100% 播放。</p>
            </section>}
            {tab === "speed" && <section>
              <h4>常规变速</h4>
              <Slider label="倍速" value={Math.log10(clip.speed)} min={-1} max={1} step={0.01} format={() => `${clip.speed.toFixed(2)}×`} onChange={(value) => onChange({ speed: Number((10 ** value).toFixed(2)) }, "speed")} onReset={() => onChange({ speed: 1 }, "speed-reset")} />
              <div className="speed-presets">{[0.25, 0.5, 1, 1.5, 2, 3, 5].map((value) => <button key={value} className={clip.speed === value ? "active" : ""} onClick={() => onChange({ speed: value }, "speed-preset")}>{value}×</button>)}</div>
              <label className="speed-input">自定义倍速<input type="number" min="0.1" max="10" step="0.05" placeholder={clip.speed.toString()} value={speedInput} onChange={(event) => setSpeedInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { const value = Number(speedInput); if (value >= 0.1 && value <= 10) onChange({ speed: value }, "speed-input"); setSpeedInput(""); } }} /></label>
              <label className="inspector-toggle"><input type="checkbox" checked={clip.reverse} onChange={(event) => onChange({ reverse: event.target.checked }, "reverse")} />倒放</label>
              <p className="inspector-note">变速后时长 {clipDuration(clip).toFixed(2)} 秒（原素材 {(clip.out - clip.in).toFixed(2)} 秒）。声音随倍速保持音调。</p>
            </section>}
            {tab === "animation" && <section>
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
