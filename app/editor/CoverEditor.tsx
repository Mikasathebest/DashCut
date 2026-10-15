"use client";

import { ChangeEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import {
  applyCollage, backgroundImage, CollageLayout, CoverDesign, CoverImage, CoverLayer, CoverText, coverFonts, drawCover, layerBounds, newImage, newText, Rect, setBackground,
} from "./cover";
import { Icon } from "./icons";
import { formatClock } from "./Timeline";
import type { Asset } from "./model";

export type FrameSource = { asset: Asset; sourceTime: number } | null;

type CoverEditorProps = {
  design: CoverDesign;
  ratio: "16:9" | "9:16";
  duration: number;
  initialTime: number;
  frameAt: (time: number) => FrameSource;
  onChange: (design: CoverDesign) => void;
  onApply: (png: string) => void;
  onClose: () => void;
};

type Drag = { id: string; mode: "move" | "scale" | "width" | "height"; x0: number; y0: number; start: CoverLayer; startBounds: Rect };

const swatches = ["#ffffff", "#111111", "#ffcc45", "#ff5a5f", "#56e0c7", "#4c7dff", "#ff9a3d", "#c084fc"];
const boxSwatches = ["rgba(0,0,0,0.55)", "rgba(255,255,255,0.85)", "#111111", "#ffcc45", "#ff5a5f", "#4c7dff"];
const backgrounds = ["#10141d", "#000000", "#ffffff", "#1e3a5f", "#7a1f3d", "#f4e3c1"];
const collages: Array<[CollageLayout, string]> = [["row", "左右"], ["column", "上下"], ["grid", "宫格"], ["feature", "一大多小"]];
const snapDistance = 0.012;

/** Reads a picked file as a data URL, shrinking very large pictures so the project file stays small. */
async function readPicture(file: File): Promise<{ src: string; aspect: number } | null> {
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    if (!image) return null;
    const scale = Math.min(1, 2400 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);
    canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
    const transparent = /png|webp|gif/.test(file.type);
    return { src: canvas.toDataURL(transparent ? "image/png" : "image/jpeg", 0.9), aspect: image.naturalWidth / image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

export function CoverEditor({ design, ratio, duration, initialTime, frameAt, onChange, onApply, onClose }: CoverEditorProps) {
  const width = ratio === "16:9" ? 1920 : 1080;
  const height = ratio === "16:9" ? 1080 : 1920;
  const aspect = width / height;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const images = useRef(new Map<string, HTMLImageElement>());
  const [imageVersion, setImageVersion] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [guides, setGuides] = useState<{ x: boolean; y: boolean }>({ x: false, y: false });
  const [stageScale, setStageScale] = useState(1);
  const [gap, setGap] = useState(0.01);
  const designRef = useRef(design);
  const selectedIdRef = useRef(selectedId);
  const onCloseRef = useRef(onClose);
  useEffect(() => { designRef.current = design; selectedIdRef.current = selectedId; onCloseRef.current = onClose; });
  const selected = design.layers.find((layer) => layer.id === selectedId) ?? null;
  const measure = useMemo(() => document.createElement("canvas").getContext("2d")!, []);

  // Load every picture once; redraw when each arrives.
  useEffect(() => {
    for (const layer of design.layers) {
      if (layer.kind !== "image" || images.current.has(layer.src)) continue;
      const image = new Image();
      image.onload = () => setImageVersion((value) => value + 1);
      image.src = layer.src;
      images.current.set(layer.src, image);
    }
  }, [design.layers]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = width;
    canvas.height = height;
    drawCover(canvas.getContext("2d")!, design, width, height, images.current);
  }, [design, width, height, imageVersion]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(([entry]) => setStageScale(entry.contentRect.width / width));
    observer.observe(stage);
    return () => observer.disconnect();
  }, [width]);

  const update = (id: string, patch: Partial<CoverImage> | Partial<CoverText>) => onChange({ ...designRef.current, layers: designRef.current.layers.map((layer) => layer.id === id ? { ...layer, ...patch } as CoverLayer : layer) });
  const remove = (id: string) => { onChange({ ...designRef.current, layers: designRef.current.layers.filter((layer) => layer.id !== id) }); setSelectedId(null); };
  const add = (layer: CoverLayer) => { onChange({ ...designRef.current, layers: [...designRef.current.layers, layer] }); setSelectedId(layer.id); };
  function reorder(id: string, direction: 1 | -1) {
    const layers = [...designRef.current.layers];
    const index = layers.findIndex((layer) => layer.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= layers.length) return;
    [layers[index], layers[target]] = [layers[target], layers[index]];
    onChange({ ...designRef.current, layers });
  }

  /* ------------------------------------------------------------ keyboard */

  useEffect(() => {
    // Captured at the window so the timeline's shortcuts (delete clip, play…) do not fire behind the dialog.
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, select, [contenteditable=true]")) return;
      const id = selectedIdRef.current;
      const key = event.key;
      if (key === "Escape") { event.stopPropagation(); return id ? setSelectedId(null) : onCloseRef.current(); }
      if (!id) {
        if (key === " " || key === "Backspace" || key === "Delete" || key.startsWith("Arrow")) { event.preventDefault(); event.stopPropagation(); }
        return;
      }
      event.stopPropagation();
      if (key === "Backspace" || key === "Delete") { event.preventDefault(); return remove(id); }
      const step = event.shiftKey ? 0.02 : 0.002;
      const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[key];
      if (delta) {
        event.preventDefault();
        const layer = designRef.current.layers.find((item) => item.id === id);
        if (layer) update(id, { x: layer.x + delta[0], y: layer.y + delta[1] });
      } else if (key === " ") event.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  /* ------------------------------------------------------------ dragging */

  function hit(clientX: number, clientY: number): CoverLayer | null {
    const rect = stageRef.current!.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * width;
    const y = ((clientY - rect.top) / rect.height) * height;
    // Topmost first; the background picture is only picked when nothing else is under the pointer.
    const ordered = [...design.layers].reverse().sort((a, b) => Number(a.kind === "image" && a.background) - Number(b.kind === "image" && b.background));
    return ordered.find((layer) => {
      const box = layerBounds(measure, layer, width, height);
      return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
    }) ?? null;
  }

  function startDrag(event: ReactPointerEvent, mode: Drag["mode"], layer: CoverLayer) {
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(layer.id);
    setDrag({ id: layer.id, mode, x0: event.clientX, y0: event.clientY, start: layer, startBounds: layerBounds(measure, layer, width, height) });
  }

  useEffect(() => {
    if (!drag) return;
    const onMove = (event: PointerEvent) => {
      const rect = stageRef.current!.getBoundingClientRect();
      const dx = (event.clientX - drag.x0) / rect.width;
      const dy = (event.clientY - drag.y0) / rect.height;
      const start = drag.start;
      const box = { x: drag.startBounds.x / width, y: drag.startBounds.y / height, w: drag.startBounds.w / width, h: drag.startBounds.h / height };
      if (drag.mode === "move") {
        let x = start.x + dx;
        let y = start.y + dy;
        // Snap the layer's centre (and edges for full-bleed pictures) to the canvas centre lines.
        const snapX = Math.abs(x + box.w / 2 - 0.5) < snapDistance;
        const snapY = Math.abs(y + box.h / 2 - 0.5) < snapDistance;
        if (snapX) x = 0.5 - box.w / 2;
        if (snapY) y = 0.5 - box.h / 2;
        if (Math.abs(x) < snapDistance) x = 0;
        if (Math.abs(y) < snapDistance) y = 0;
        setGuides({ x: snapX, y: snapY });
        return update(drag.id, { x, y });
      }
      if (start.kind === "text") {
        // Text scales from its top-left corner by the larger of the two drag directions.
        const factor = Math.max(0.1, Math.max((box.w + dx) / box.w, (box.h + dy) / box.h));
        return update(drag.id, { size: Math.max(0.01, Math.min(0.6, start.size * factor)) });
      }
      if (drag.mode === "width") return update(drag.id, { w: Math.max(0.03, start.w + dx) });
      if (drag.mode === "height") return update(drag.id, { h: Math.max(0.03, start.h + dy) });
      // Corner keeps the box's current proportions.
      const factor = Math.max(0.05, Math.max((start.w + dx) / start.w, (start.h + dy) / start.h));
      update(drag.id, { w: start.w * factor, h: start.h * factor });
    };
    const onUp = () => { setDrag(null); setGuides({ x: false, y: false }); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  });

  /* ------------------------------------------------------------ video frame picker */

  const [frameTime, setFrameTime] = useState(Math.min(initialTime, Math.max(0, duration - 0.05)));
  const previewRef = useRef<HTMLCanvasElement>(null);
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const pending = useRef<number | null>(null);
  const [frameMissing, setFrameMissing] = useState(false);

  // One hidden <video> per clip source; seeking it is fast enough to follow the slider.
  async function drawFrame(time: number, target: HTMLCanvasElement, maxWidth: number) {
    const source = frameAt(time);
    if (!source || source.asset.kind === "audio" || !source.asset.url) return false;
    let picture: HTMLVideoElement | HTMLImageElement | null = null;
    let w = 0;
    let h = 0;
    if (source.asset.kind === "video") {
      let video = videos.current.get(source.asset.url);
      if (!video) {
        video = document.createElement("video");
        video.muted = true;
        video.preload = "auto";
        video.crossOrigin = "anonymous";
        video.src = source.asset.url;
        videos.current.set(source.asset.url, video);
      }
      if (video.readyState < 2) await new Promise((resolve) => video!.addEventListener("loadeddata", resolve, { once: true }));
      const wanted = Math.max(0, Math.min(source.asset.duration - 0.05, source.sourceTime));
      if (Math.abs(video.currentTime - wanted) > 0.01) {
        video.currentTime = wanted;
        await new Promise((resolve) => video!.addEventListener("seeked", resolve, { once: true }));
      }
      picture = video;
      w = video.videoWidth;
      h = video.videoHeight;
    } else {
      picture = images.current.get(source.asset.url) ?? await loadImage(source.asset.url);
      if (picture) images.current.set(source.asset.url, picture);
      w = picture?.naturalWidth ?? 0;
      h = picture?.naturalHeight ?? 0;
    }
    if (!picture || !w || !h) return false;
    const scale = Math.min(1, maxWidth / w);
    target.width = Math.round(w * scale);
    target.height = Math.round(h * scale);
    target.getContext("2d")!.drawImage(picture, 0, 0, target.width, target.height);
    return true;
  }

  const busy = useRef(false);
  function showFrame(time: number) {
    setFrameTime(time);
    requestFrame(time);
  }
  function requestFrame(time: number) {
    pending.current = time;
    if (busy.current) return;
    busy.current = true;
    void (async () => {
      // Always finish on the latest requested time, skipping the ones in between.
      while (pending.current !== null) {
        const next = pending.current;
        pending.current = null;
        const ok = previewRef.current ? await drawFrame(next, previewRef.current, 480) : false;
        setFrameMissing(!ok);
      }
      busy.current = false;
    })();
  }
  useEffect(() => {
    requestFrame(frameTime);
    const cache = videos.current;
    return () => { for (const video of cache.values()) { video.removeAttribute("src"); video.load(); } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function takeFrame(asBackground: boolean) {
    const canvas = document.createElement("canvas");
    if (!(await drawFrame(frameTime, canvas, 1920))) return;
    const src = canvas.toDataURL("image/jpeg", 0.92);
    const pictureAspect = canvas.width / canvas.height;
    if (asBackground) {
      const layer = backgroundImage(src, pictureAspect, frameTime);
      onChange(setBackground(designRef.current, layer));
      setSelectedId(null);
    } else add({ ...newImage(src, pictureAspect, aspect, designRef.current.layers.length), frameTime });
  }

  async function onFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    const pictures = (await Promise.all(files.map(readPicture))).filter((item): item is { src: string; aspect: number } => Boolean(item));
    if (!pictures.length) return;
    const start = designRef.current.layers.length;
    const layers = pictures.map((picture, index) => newImage(picture.src, picture.aspect, aspect, start + index));
    let next = { ...designRef.current, layers: [...designRef.current.layers, ...layers] };
    // Several pictures at once are laid out side by side straight away; they can still be moved freely.
    const count = next.layers.filter((layer) => layer.kind === "image" && !layer.background).length;
    if (pictures.length > 1) next = applyCollage(next, count <= 3 ? "row" : "grid", gap, aspect);
    onChange(next);
    setSelectedId(layers[layers.length - 1].id);
  }

  function addText() {
    const layer = newText(t("双击输入文字"));
    add(layer);
    requestAnimationFrame(() => { textRef.current?.focus(); textRef.current?.select(); });
  }

  function exportPng(download: boolean) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    drawCover(canvas.getContext("2d")!, designRef.current, width, height, images.current);
    const png = canvas.toDataURL("image/png");
    if (download) {
      const link = document.createElement("a");
      link.href = png;
      link.download = t("视频封面.png");
      link.click();
    }
    onApply(png);
  }

  const pictures = design.layers.filter((layer) => layer.kind === "image" && !layer.background).length;
  const selectedBounds = selected ? layerBounds(measure, selected, width, height) : null;
  const handles = selected?.kind === "image" && !selected.background ? ["scale", "width", "height"] as const : selected?.kind === "text" ? ["scale"] as const : [];

  return <div className="modal-backdrop" onMouseDown={onClose}><section className="cover-modal cover-studio" onMouseDown={(event) => event.stopPropagation()}>
    <header><div><span className="eyebrow">COVER STUDIO</span><h2>{t("编辑封面")}</h2></div><button onClick={onClose}>×</button></header>
    <div className="cover-workspace">
      <div className="canvas-wrap">
        <div className="cover-stage-area"><div className={`cover-stage ratio-${ratio === "16:9" ? "wide" : "tall"}`} ref={stageRef}
          onPointerDown={(event) => { if (event.button !== 0) return; const layer = hit(event.clientX, event.clientY); if (layer) startDrag(event, "move", layer); else setSelectedId(null); }}
          onDoubleClick={(event) => { const layer = hit(event.clientX, event.clientY); if (layer?.kind === "text") { setSelectedId(layer.id); requestAnimationFrame(() => { textRef.current?.focus(); textRef.current?.select(); }); } }}>
          <canvas ref={canvasRef} />
          {!design.layers.length && <div className="cover-empty"><Icon name="image" size={26} /><span>{t("上传图片、从视频选一帧，或添加文字")}</span></div>}
          {guides.x && <i className="cover-guide vertical" />}
          {guides.y && <i className="cover-guide horizontal" />}
          {selected && selectedBounds && <div className="cover-selection" style={{ left: selectedBounds.x * stageScale, top: selectedBounds.y * stageScale, width: selectedBounds.w * stageScale, height: selectedBounds.h * stageScale }}>
            {handles.map((mode) => <i key={mode} className={`cover-handle ${mode}`} onPointerDown={(event) => startDrag(event, mode, selected)} />)}
          </div>}
        </div></div>
        <div className="frame-picker">
          <canvas ref={previewRef} className={frameMissing ? "missing" : ""} />
          <div className="frame-controls">
            <div className="frame-row"><b>{t("从视频选帧")}</b><span>{formatClock(frameTime, true)}</span></div>
            <input type="range" min={0} max={Math.max(0.05, duration - 0.05)} step={0.01} value={frameTime} disabled={duration <= 0} aria-label={t("拖动选择视频帧")} onChange={(event) => showFrame(Number(event.target.value))} />
            <div className="frame-row">
              <button className="ghost-action" disabled={frameMissing || duration <= 0} onClick={() => void takeFrame(true)}>{t("设为背景")}</button>
              <button className="ghost-action" disabled={frameMissing || duration <= 0} onClick={() => void takeFrame(false)}>{t("添加为图层")}</button>
            </div>
          </div>
        </div>
      </div>
      <aside>
        <div className="cover-add">
          <button onClick={() => fileRef.current?.click()}><Icon name="image" size={16} />{t("上传图片")}</button>
          <button onClick={addText}><Icon name="text" size={16} />{t("添加文字")}</button>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(event) => void onFiles(event)} />
        </div>
        {pictures > 1 && <div className="cover-section">
          <b>{t("拼接")}</b>
          <div className="cover-chips">{collages.map(([layout, label]) => <button key={layout} onClick={() => onChange(applyCollage(designRef.current, layout, gap, aspect))}>{t(label)}</button>)}</div>
          <label className="cover-slider">{t("间距")}<input type="range" min={0} max={0.04} step={0.002} value={gap} onChange={(event) => setGap(Number(event.target.value))} /></label>
        </div>}
        {selected?.kind === "text" && <TextControls layer={selected} textRef={textRef} onChange={(patch) => update(selected.id, patch)} />}
        {selected?.kind === "image" && <div className="cover-section">
          <b>{selected.background ? t("背景图片") : t("图片")}</b>
          {!selected.background && <div className="cover-chips"><button className={selected.fit === "cover" ? "active" : ""} onClick={() => update(selected.id, { fit: "cover" })}>{t("填满裁切")}</button><button className={selected.fit === "contain" ? "active" : ""} onClick={() => update(selected.id, { fit: "contain" })}>{t("完整显示")}</button><button onClick={() => update(selected.id, { h: (selected.w * aspect) / selected.aspect })}>{t("原始比例")}</button></div>}
          <small className="cover-hint">{selected.background ? t("背景铺满画布；可以拖动其他图层叠在上面") : t("拖动移动；右下角等比缩放，右边和下边单独拉伸")}</small>
        </div>}
        {selected && <div className="cover-chips layer-actions">
          <button title={t("上移一层")} onClick={() => reorder(selected.id, 1)}>{t("上移")}</button>
          <button title={t("下移一层")} onClick={() => reorder(selected.id, -1)}>{t("下移")}</button>
          <button className="danger" onClick={() => remove(selected.id)}>{t("删除")}</button>
        </div>}
        {!selected && <div className="cover-section">
          <b>{t("背景色")}</b>
          <div className="color-options">{backgrounds.map((color) => <button key={color} className={design.background === color ? "active" : ""} style={{ background: color }} onClick={() => onChange({ ...design, background: color })} />)}<input type="color" value={design.background} onChange={(event) => onChange({ ...design, background: event.target.value })} aria-label={t("自定义颜色")} /></div>
          <small className="cover-hint">{t("点击画布上的图层即可选中、拖动和修改；⌫ 删除所选图层")}</small>
        </div>}
        <div className="cover-footer">
          <button className="ghost-action" onClick={() => exportPng(true)} disabled={!design.layers.length}>{t("保存 PNG")}</button>
          <button className="primary" onClick={() => { exportPng(false); onClose(); }}>{t("完成")}</button>
        </div>
      </aside>
    </div>
  </section></div>;
}

function TextControls({ layer, textRef, onChange }: { layer: CoverText; textRef: React.RefObject<HTMLTextAreaElement | null>; onChange: (patch: Partial<CoverText>) => void }) {
  return <div className="cover-section">
    <b>{t("文字")}</b>
    <textarea ref={textRef} rows={2} value={layer.text} placeholder={t("输入文字，回车换行")} onChange={(event) => onChange({ text: event.target.value })} />
    <select value={layer.font} onChange={(event) => onChange({ font: event.target.value })} aria-label={t("字体")}>{coverFonts.map((font) => <option key={font.value} value={font.value}>{t(font.label)}</option>)}</select>
    <label className="cover-slider">{t("字号")}<input type="range" min={0.02} max={0.3} step={0.002} value={layer.size} onChange={(event) => onChange({ size: Number(event.target.value) })} /></label>
    <div className="cover-chips">
      <button className={layer.bold ? "active" : ""} onClick={() => onChange({ bold: !layer.bold })}><b>B</b></button>
      <button className={layer.italic ? "active" : ""} onClick={() => onChange({ italic: !layer.italic })}><i>I</i></button>
      {(["left", "center", "right"] as const).map((align) => <button key={align} className={layer.align === align ? "active" : ""} onClick={() => onChange({ align })}>{align === "left" ? t("左") : align === "center" ? t("中") : t("右")}</button>)}
      <button className={layer.shadow ? "active" : ""} onClick={() => onChange({ shadow: !layer.shadow })}>{t("阴影")}</button>
    </div>
    <ColorRow label={t("颜色")} value={layer.color} onChange={(color) => onChange({ color: color ?? "#ffffff" })} />
    <ColorRow label={t("描边")} value={layer.stroke} onChange={(stroke) => onChange({ stroke })} optional />
    {layer.stroke && <label className="cover-slider">{t("描边粗细")}<input type="range" min={0.02} max={0.25} step={0.01} value={layer.strokeWidth} onChange={(event) => onChange({ strokeWidth: Number(event.target.value) })} /></label>}
    <ColorRow label={t("底框")} value={layer.box} onChange={(box) => onChange({ box })} optional colors={boxSwatches} />
  </div>;
}

function ColorRow({ label, value, onChange, optional, colors = swatches }: { label: string; value: string | null; onChange: (value: string | null) => void; optional?: boolean; colors?: string[] }) {
  return <div className="cover-color-row"><span>{label}</span><div className="color-options">
    {optional && <button className={`none${value === null ? " active" : ""}`} title={t("无")} onClick={() => onChange(null)}>⌀</button>}
    {colors.map((color) => <button key={color} className={value === color ? "active" : ""} style={{ background: color }} onClick={() => onChange(color)} />)}
    <input type="color" value={value?.startsWith("#") ? value : "#000000"} onChange={(event) => onChange(event.target.value)} aria-label={label} />
  </div></div>;
}
