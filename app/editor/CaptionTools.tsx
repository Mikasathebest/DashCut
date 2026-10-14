"use client";

import { useState } from "react";
import { defaultSubtitleStyle, SubtitleStyle, subtitlePresets } from "./captions";

const fonts: Array<[string, string]> = [
  ['Arial, "PingFang SC", "Microsoft YaHei", sans-serif', "系统黑体"],
  ['Georgia, "Songti SC", serif', "中英衬线"],
  ['"Arial Black", "PingFang SC", sans-serif', "醒目粗体"],
  ['"Courier New", monospace', "等宽字体"],
];

type StyleProps = { style: SubtitleStyle; onChange: (style: SubtitleStyle) => void };

export function CaptionStyleEditor({ style, onChange }: StyleProps) {
  const set = <K extends keyof SubtitleStyle>(key: K, value: SubtitleStyle[K]) => onChange({ ...style, [key]: value });
  return <div className="subtitle-style-editor">
    <div className="style-editor-title"><strong>全局字幕样式</strong><span>预览与导出一致</span></div>
    <div className="style-presets">{subtitlePresets.map((preset) => <button key={preset.name} onClick={() => onChange({ ...style, ...preset.style })}>{preset.name}</button>)}</div>

    <b className="style-section">格式</b>
    <div className="style-segment" role="group" aria-label="双语顺序">
      <button className={style.order === "zh-first" ? "active" : ""} onClick={() => set("order", "zh-first")}>中文在上</button>
      <button className={style.order === "en-first" ? "active" : ""} onClick={() => set("order", "en-first")}>英文在上</button>
    </div>
    <label>字体<select value={style.fontFamily} onChange={(event) => set("fontFamily", event.target.value)}>{fonts.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
    <label>字号 <b>{style.fontSize}px</b><input type="range" min="20" max="72" value={style.fontSize} onChange={(event) => set("fontSize", Number(event.target.value))} /></label>
    <label>次行 <b>{style.enScale}%</b><input type="range" min="40" max="100" value={style.enScale} onChange={(event) => set("enScale", Number(event.target.value))} /></label>

    <b className="style-section">位置</b>
    <div className="style-segment" role="group" aria-label="字幕位置">
      {([["top", "顶部"], ["middle", "居中"], ["bottom", "底部"]] as const).map(([value, name]) => <button key={value} className={style.position === value ? "active" : ""} onClick={() => set("position", value)}>{name}</button>)}
    </div>
    {style.position !== "middle" && <label>边距 <b>{style.offset}%</b><input type="range" min="0" max="40" value={style.offset} onChange={(event) => set("offset", Number(event.target.value))} /></label>}

    <b className="style-section">颜色</b>
    <div className="style-color-grid">
      <label>中文<input type="color" value={style.color} onChange={(event) => set("color", event.target.value)} /></label>
      <label>英文<input type="color" value={style.enColor} onChange={(event) => set("enColor", event.target.value)} /></label>
      <label>描边<input type="color" value={style.outlineColor} onChange={(event) => set("outlineColor", event.target.value)} /></label>
      <label>背景<input type="color" value={style.backgroundColor} onChange={(event) => set("backgroundColor", event.target.value)} /></label>
    </div>
    <label>描边 <b>{style.outlineWidth}px</b><input type="range" min="0" max="8" value={style.outlineWidth} disabled={style.backgroundOpacity > 0} onChange={(event) => set("outlineWidth", Number(event.target.value))} /></label>
    <label>背景 <b>{style.backgroundOpacity}%</b><input type="range" min="0" max="100" step="5" value={style.backgroundOpacity} onChange={(event) => set("backgroundOpacity", Number(event.target.value))} /></label>
    {style.backgroundOpacity > 0 && <small className="style-note">开启背景后不显示描边</small>}
    <button className="reset-style" onClick={() => onChange(defaultSubtitleStyle)}>恢复默认样式</button>
  </div>;
}

type TimingProps = { disabled: boolean; selected: boolean; onShift: (delta: number, fromSelected: boolean) => void };

/** One-click caption offset: shift everything, or the selected caption and everything after it. */
export function CaptionTimingBar({ disabled, selected, onShift }: TimingProps) {
  const [fromSelected, setFromSelected] = useState(false);
  const [custom, setCustom] = useState("1.5");
  const scoped = fromSelected && selected;
  const shift = (delta: number) => onShift(delta, scoped);
  return <div className="caption-timing">
    <div className="caption-timing-head">
      <strong>时间偏移</strong>
      <div className="style-segment" role="group" aria-label="偏移范围">
        <button className={!scoped ? "active" : ""} onClick={() => setFromSelected(false)}>全部字幕</button>
        <button className={scoped ? "active" : ""} disabled={!selected} title={selected ? "" : "先在列表或时间轴中选中一条字幕"} onClick={() => setFromSelected(true)}>选中及之后</button>
      </div>
    </div>
    <div className="caption-timing-buttons">
      {[-1, -0.5, -0.1].map((delta) => <button key={delta} disabled={disabled} onClick={() => shift(delta)}>{delta}s</button>)}
      {[0.1, 0.5, 1].map((delta) => <button key={delta} disabled={disabled} onClick={() => shift(delta)}>+{delta}s</button>)}
    </div>
    <div className="caption-timing-custom">
      <input type="number" step="0.1" value={custom} aria-label="自定义偏移秒数" onChange={(event) => setCustom(event.target.value)} />
      <button disabled={disabled || !Number(custom)} onClick={() => shift(-Math.abs(Number(custom)))}>提前</button>
      <button disabled={disabled || !Number(custom)} onClick={() => shift(Math.abs(Number(custom)))}>延后</button>
    </div>
    <small>字幕显示偏早就“延后”，偏晚就“提前”。修改某条的开始时间，后面的字幕会一起移动。</small>
  </div>;
}
