"use client";

import { CSSProperties, memo, PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";
import { Asset, Clip, clipDuration, clipEnd, isStretchable, minClipDuration, Project, snapCandidates, snapTime, Track } from "./model";

export type TimelineMode = "select" | "blade";
export type DropTarget = string | "new-top" | "new-bottom";
export type TimelineSettings = { videoHeight: number; audioHeight: number; waveformRatio: number };
export type Toggles = { magnet: boolean; snap: boolean; linkage: boolean; previewAxis: boolean };

const headerWidth = 112;
const tickSteps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

export function formatClock(value: number, withFrames = true) {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  const min = Math.floor(safe / 60);
  const sec = Math.floor(safe % 60);
  const base = `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return withFrames ? `${base}:${String(Math.floor((safe % 1) * 30)).padStart(2, "0")}` : base;
}

/* ---------------------------------------------------------------- toolbar */

type ToolbarProps = {
  mode: TimelineMode;
  onMode: (mode: TimelineMode) => void;
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  selectionIsVideo: boolean;
  recording: "idle" | number | "recording";
  toggles: Toggles;
  zoom: number;
  settings: TimelineSettings;
  onAction: (action: ToolbarAction) => void;
  onToggle: (key: keyof Toggles) => void;
  onZoom: (zoom: number) => void;
  onSettings: (settings: TimelineSettings) => void;
};
export type ToolbarAction = "import" | "undo" | "redo" | "reset" | "split" | "trim-left" | "trim-right" | "delete" | "marker" | "freeze" | "reverse" | "mirror" | "rotate" | "crop"
  | "smart-extend" | "smart-talk" | "smart-scenes" | "smart-rough" | "record" | "fit";

function ToolButton({ icon, label, onClick, disabled, active, accent }: { icon: string; label: string; onClick: () => void; disabled?: boolean; active?: boolean; accent?: boolean }) {
  return <button className={`tool-button${active ? " active" : ""}${accent ? " accent" : ""}`} title={label} aria-label={label} disabled={disabled} onClick={onClick}><Icon name={icon} /></button>;
}

export const TimelineToolbar = memo(function TimelineToolbar({ mode, onMode, canUndo, canRedo, hasSelection, selectionIsVideo, recording, toggles, zoom, settings, onAction, onToggle, onZoom, onSettings }: ToolbarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  return <div className="timeline-toolbar">
    <div className="toolbar-group">
      <ToolButton icon="plus" label="导入新素材" onClick={() => onAction("import")} accent />
      <ToolButton icon={mode === "select" ? "pointer" : "blade"} label={mode === "select" ? "选择模式（B 切换到分割模式）" : "分割模式：点击片段即可分割（A 切回选择）"} active={mode === "blade"} onClick={() => onMode(mode === "select" ? "blade" : "select")} />
      <ToolButton icon="undo" label="撤销 ⌘Z" disabled={!canUndo} onClick={() => onAction("undo")} />
      <ToolButton icon="redo" label="重做 ⇧⌘Z" disabled={!canRedo} onClick={() => onAction("redo")} />
      <ToolButton icon="reset" label="重置所选片段的全部调整" disabled={!hasSelection} onClick={() => onAction("reset")} />
      <i className="toolbar-divider" />
      <ToolButton icon="split" label="分割 ⌘B" onClick={() => onAction("split")} />
      <ToolButton icon="trimLeft" label="向左裁剪：删除播放头左侧 Q" disabled={!hasSelection} onClick={() => onAction("trim-left")} />
      <ToolButton icon="trimRight" label="向右裁剪：删除播放头右侧 W" disabled={!hasSelection} onClick={() => onAction("trim-right")} />
      <ToolButton icon="trash" label="删除 ⌫" disabled={!hasSelection} onClick={() => onAction("delete")} />
      <ToolButton icon="marker" label="添加标记 M" onClick={() => onAction("marker")} />
      <ToolButton icon="freeze" label="定格 3 秒" disabled={!selectionIsVideo} onClick={() => onAction("freeze")} />
      <ToolButton icon="reverse" label="倒放" disabled={!selectionIsVideo} onClick={() => onAction("reverse")} />
      <ToolButton icon="mirror" label="镜像" disabled={!hasSelection} onClick={() => onAction("mirror")} />
      <ToolButton icon="rotate" label="旋转 90°" disabled={!hasSelection} onClick={() => onAction("rotate")} />
      <ToolButton icon="crop" label="裁剪画面" disabled={!hasSelection} onClick={() => onAction("crop")} />
      <i className="toolbar-divider" />
      <ToolButton icon="extend" label="智能延长（即将推出）" onClick={() => onAction("smart-extend")} />
      <ToolButton icon="talk" label="智能剪口播：自动剪掉停顿" disabled={!hasSelection} onClick={() => onAction("smart-talk")} />
      <ToolButton icon="scenes" label="智能镜头分割" disabled={!selectionIsVideo} onClick={() => onAction("smart-scenes")} />
      <ToolButton icon="rough" label="智能粗剪（即将推出）" onClick={() => onAction("smart-rough")} />
      <button className={`record-button${recording !== "idle" ? " live" : ""}`} title={recording === "recording" ? "停止录音" : "录音（倒数 3 秒）"} onClick={() => onAction("record")}><Icon name="mic" />{recording === "recording" ? <span>录音中</span> : typeof recording === "number" ? <span>{recording}</span> : null}</button>
    </div>
    <div className="toolbar-group">
      <ToolButton icon="magnet" label={`主轨磁吸：${toggles.magnet ? "开" : "关"}`} active={toggles.magnet} onClick={() => onToggle("magnet")} />
      <ToolButton icon="snap" label={`自动吸附：${toggles.snap ? "开" : "关"}`} active={toggles.snap} onClick={() => onToggle("snap")} />
      <ToolButton icon="link" label={`联动：${toggles.linkage ? "开" : "关"}`} active={toggles.linkage} onClick={() => onToggle("linkage")} />
      <ToolButton icon="previewAxis" label={`预览轴：${toggles.previewAxis ? "开" : "关"}`} active={toggles.previewAxis} onClick={() => onToggle("previewAxis")} />
      <ToolButton icon="fit" label="全局预览缩放（适应窗口）" onClick={() => onAction("fit")} />
      <i className="toolbar-divider" />
      <ToolButton icon="minus" label="缩小时间轴" onClick={() => onZoom(zoom / 1.4)} />
      <input className="zoom-slider" type="range" min={Math.log(2)} max={Math.log(400)} step={0.01} value={Math.log(zoom)} onChange={(event) => onZoom(Math.exp(Number(event.target.value)))} aria-label="时间轴缩放" />
      <ToolButton icon="plus" label="放大时间轴" onClick={() => onZoom(zoom * 1.4)} />
      <div className="toolbar-menu">
        <ToolButton icon="more" label="轨道设置" active={menuOpen} onClick={() => setMenuOpen(!menuOpen)} />
        {menuOpen && <div className="toolbar-popover" onPointerDown={(event) => event.stopPropagation()}>
          <b>轨道显示</b>
          <label>视频轨高度<input type="range" min="36" max="120" value={settings.videoHeight} onChange={(event) => onSettings({ ...settings, videoHeight: Number(event.target.value) })} /><span>{settings.videoHeight}px</span></label>
          <label>音频轨高度<input type="range" min="28" max="100" value={settings.audioHeight} onChange={(event) => onSettings({ ...settings, audioHeight: Number(event.target.value) })} /><span>{settings.audioHeight}px</span></label>
          <label>波形占比<input type="range" min="0" max="70" value={Math.round(settings.waveformRatio * 100)} onChange={(event) => onSettings({ ...settings, waveformRatio: Number(event.target.value) / 100 })} /><span>{Math.round(settings.waveformRatio * 100)}%</span></label>
        </div>}
      </div>
    </div>
  </div>;
});

/* ---------------------------------------------------------------- clip visuals */

function Waveform({ asset, clip, width, height }: { asset: Asset; clip: Clip; width: number; height: number }) {
  const path = useMemo(() => {
    if (!asset.peaks.length || width < 2 || height < 2) return "";
    const bars = Math.max(1, Math.min(600, Math.floor(width / 2)));
    const span = clip.out - clip.in;
    let d = "";
    for (let index = 0; index < bars; index += 1) {
      const offset = (span * index) / bars;
      const source = clip.reverse ? clip.out - offset : clip.in + offset;
      const from = Math.floor(source * asset.peaksPerSecond);
      const to = Math.max(from + 1, Math.floor((source + span / bars) * asset.peaksPerSecond));
      let peak = 0;
      for (let cursor = from; cursor < to && cursor < asset.peaks.length; cursor += 1) peak = Math.max(peak, asset.peaks[cursor]);
      const bar = Math.max(0.5, peak * height * Math.min(2, clip.audio.volume) * 0.9);
      const x = ((index + 0.5) / bars) * width;
      d += `M${x.toFixed(1)} ${(height / 2 - bar / 2).toFixed(1)}v${bar.toFixed(1)}`;
    }
    return d;
  }, [asset.peaks, asset.peaksPerSecond, clip.audio.volume, clip.in, clip.out, clip.reverse, height, width]);
  return <svg className="clip-waveform" width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"><path d={path} strokeWidth={Math.max(1, Math.min(2, width / 600))} /></svg>;
}

function Filmstrip({ asset, clip, width, height }: { asset: Asset; clip: Clip; width: number; height: number }) {
  const aspect = asset.width && asset.height ? asset.width / asset.height : 16 / 9;
  const tileWidth = Math.max(24, height * aspect);
  const count = Math.max(1, Math.min(160, Math.ceil(width / tileWidth)));
  const tiles = Array.from({ length: count }, (_, index) => {
    if (asset.kind !== "video" || clip.freezeAt !== null || !asset.frames.length) return clip.freezeAt !== null && asset.frames.length ? asset.frames[Math.min(asset.frames.length - 1, Math.floor((clip.freezeAt / asset.duration) * asset.frames.length))] : asset.thumbnail;
    const offset = ((clip.out - clip.in) * (index + 0.5)) / count;
    const source = clip.reverse ? clip.out - offset : clip.in + offset;
    return asset.frames[Math.max(0, Math.min(asset.frames.length - 1, Math.floor((source / asset.duration) * asset.frames.length)))];
  });
  return <div className="clip-filmstrip" style={{ height }}>{tiles.map((src, index) => <i key={index} style={{ width: width / count, backgroundImage: src ? `url("${src}")` : undefined }} />)}</div>;
}

/* ---------------------------------------------------------------- timeline */

type DragState =
  | { type: "move"; clipId: string; pointerX: number; originStart: number; start: number; target: DropTarget; moved: boolean }
  | { type: "trim"; clipId: string; edge: "left" | "right"; pointerX: number; patch: Partial<Clip> }
  | { type: "scrub" };

type TimelineProps = {
  project: Project;
  assets: Map<string, Asset>;
  time: number;
  hoverTime: number | null;
  duration: number;
  selection: string[];
  mode: TimelineMode;
  toggles: Toggles;
  zoom: number;
  settings: TimelineSettings;
  coverImage: string;
  draggingAssetId: string | null;
  onSeek: (time: number) => void;
  onHover: (time: number | null) => void;
  onSelect: (ids: string[]) => void;
  onDropAsset: (assetId: string, target: DropTarget, start: number) => void;
  onMoveClip: (clipId: string, target: DropTarget, start: number) => void;
  onTrimClip: (clipId: string, patch: Partial<Clip>) => void;
  onBlade: (clipId: string, time: number) => void;
  onTrack: (trackId: string, patch: Partial<Track>) => void;
  onRemoveMarker: (id: string) => void;
  onZoom: (zoom: number) => void;
  onCover: () => void;
  onViewport: (width: number) => void;
};

export function Timeline(props: TimelineProps) {
  const { project, assets, time, hoverTime, duration, selection, mode, toggles, zoom, settings, coverImage, draggingAssetId } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [assetDrop, setAssetDrop] = useState<{ target: DropTarget; start: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const propsRef = useRef(props);
  // Window-level pointer handlers read the latest drag state and callbacks through refs.
  useLayoutEffect(() => {
    propsRef.current = props;
  });

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => propsRef.current.onViewport(entry.contentRect.width - headerWidth));
    observer.observe(element);
    // Pinch / ⌘-scroll zooms around the pointer like other editors.
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const pointer = event.clientX - rect.left - headerWidth + element.scrollLeft;
      const current = propsRef.current.zoom;
      const next = Math.max(2, Math.min(400, current * Math.exp(-event.deltaY * 0.01)));
      propsRef.current.onZoom(next);
      requestAnimationFrame(() => { element.scrollLeft = (pointer / current) * next - (event.clientX - rect.left - headerWidth); });
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => { observer.disconnect(); element.removeEventListener("wheel", onWheel); };
  }, []);

  const contentWidth = Math.max((duration + 20) * zoom, 400);
  const step = tickSteps.find((value) => value * zoom >= 64) ?? 600;
  const ticks = Array.from({ length: Math.ceil(contentWidth / zoom / step) + 1 }, (_, index) => index * step);

  function timeFromClientX(clientX: number) {
    const element = scrollRef.current!;
    const rect = element.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left - headerWidth + element.scrollLeft) / zoom);
  }

  function targetFromPoint(clientX: number, clientY: number): DropTarget | null {
    const element = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-drop]");
    return element?.dataset.drop ?? null;
  }

  function snapped(value: number, ignoreId?: string) {
    return toggles.snap ? snapTime(value, snapCandidates(project, time, ignoreId), 8 / zoom) : value;
  }

  function trackKind(target: DropTarget) {
    return project.tracks.find((track) => track.id === target)?.kind;
  }

  // Window listeners are attached synchronously so a release that arrives before the next render is not lost.
  function beginDrag(initial: DragState) {
    dragRef.current = initial;
    setDrag(initial);
    // Keep the ref in step synchronously so pointerup never sees a stale, unrendered drag.
    const update = (next: DragState) => {
      dragRef.current = next;
      setDrag(next);
    };
    const move = (event: PointerEvent) => {
      const state = dragRef.current;
      if (!state) return;
      if (state.type === "scrub") return propsRef.current.onSeek(timeFromClientX(event.clientX));
      const clip = project.clips.find((item) => item.id === state.clipId);
      if (!clip) return;
      const deltaTime = (event.clientX - state.pointerX) / zoom;
      if (state.type === "move") {
        const rawStart = Math.max(0, state.originStart + deltaTime);
        const length = clipDuration(clip);
        // Snap whichever edge is closer to a candidate.
        const startSnap = snapped(rawStart, clip.id);
        const endSnap = snapped(rawStart + length, clip.id) - length;
        const start = Math.abs(startSnap - rawStart) <= Math.abs(endSnap - rawStart) ? startSnap : Math.max(0, endSnap);
        const pointed = targetFromPoint(event.clientX, event.clientY);
        const asset = assets.get(clip.assetId);
        const wantKind = asset?.kind === "audio" ? "audio" : "video";
        const target = pointed && (pointed.startsWith("new-") || trackKind(pointed) === wantKind) ? pointed : state.target;
        update({ ...state, start, target, moved: state.moved || Math.abs(event.clientX - state.pointerX) > 3 || target !== clip.trackId });
      } else {
        const asset = assets.get(clip.assetId);
        const stretch = isStretchable(clip, asset);
        const sourceLimit = asset && !stretch ? asset.duration : Infinity;
        if (state.edge === "left") {
          const desiredStart = snapped(clip.start + deltaTime, clip.id);
          let shift = desiredStart - clip.start;
          // Clamp by source availability and minimum length.
          const maxShift = clipDuration(clip) - minClipDuration;
          const minShift = stretch ? -clip.start : -Math.min(clip.start, (clip.reverse ? sourceLimit - clip.out : clip.in) / clip.speed);
          shift = Math.max(minShift, Math.min(maxShift, shift));
          const sourceShift = shift * clip.speed;
          const patch: Partial<Clip> = stretch
            ? { start: clip.start + shift, out: clip.out - sourceShift }
            : clip.reverse ? { start: clip.start + shift, out: clip.out - sourceShift } : { start: clip.start + shift, in: clip.in + sourceShift };
          update({ ...state, patch });
        } else {
          const desiredEnd = snapped(clipEnd(clip) + deltaTime, clip.id);
          let shift = desiredEnd - clipEnd(clip);
          const minShift = -(clipDuration(clip) - minClipDuration);
          const maxShift = stretch ? 3600 : ((clip.reverse ? clip.in : sourceLimit - clip.out) / clip.speed);
          shift = Math.max(minShift, Math.min(maxShift, shift));
          const sourceShift = shift * clip.speed;
          update({ ...state, patch: clip.reverse && !stretch ? { in: clip.in - sourceShift } : { out: clip.out + sourceShift } });
        }
      }
    };
    const up = (event: PointerEvent) => {
      move(event);
      window.removeEventListener("pointermove", move);
      const state = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!state || state.type === "scrub") return;
      if (state.type === "move" && state.moved) propsRef.current.onMoveClip(state.clipId, state.target, state.start);
      if (state.type === "trim" && Object.keys(state.patch).length) propsRef.current.onTrimClip(state.clipId, state.patch);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  }

  function startClipPointer(event: ReactPointerEvent, clip: Clip, track: Track) {
    if (event.button !== 0) return;
    event.stopPropagation();
    const edge = (event.target as HTMLElement).dataset.edge as "left" | "right" | undefined;
    if (mode === "blade" && !edge) {
      if (!track.locked) props.onBlade(clip.id, snapped(timeFromClientX(event.clientX), clip.id));
      return;
    }
    const additive = event.shiftKey || event.metaKey;
    props.onSelect(additive ? (selection.includes(clip.id) ? selection.filter((id) => id !== clip.id) : [...selection, clip.id]) : [clip.id]);
    if (track.locked) return;
    if (edge) beginDrag({ type: "trim", clipId: clip.id, edge, pointerX: event.clientX, patch: {} });
    else beginDrag({ type: "move", clipId: clip.id, pointerX: event.clientX, originStart: clip.start, start: clip.start, target: clip.trackId, moved: false });
  }

  function onLaneDragOver(event: React.DragEvent, target: DropTarget) {
    if (!draggingAssetId) return;
    const asset = assets.get(draggingAssetId);
    const wantKind = asset?.kind === "audio" ? "audio" : "video";
    if (!target.startsWith("new-") && trackKind(target) !== wantKind) return;
    if (project.tracks.find((track) => track.id === target)?.locked) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setAssetDrop({ target, start: snapped(timeFromClientX(event.clientX)) });
  }

  function onLaneDrop(event: React.DragEvent, target: DropTarget) {
    event.preventDefault();
    const assetId = event.dataTransfer.getData("application/x-dashcut-asset") || draggingAssetId;
    setAssetDrop(null);
    if (assetId) props.onDropAsset(assetId, target, snapped(timeFromClientX(event.clientX)));
  }

  const ghostAsset = draggingAssetId ? assets.get(draggingAssetId) : undefined;
  const rows = project.tracks;

  function renderClip(clip: Clip, track: Track, height: number) {
    const asset = assets.get(clip.assetId);
    if (!asset) return null;
    const preview = drag && "clipId" in drag && drag.clipId === clip.id ? drag : null;
    const shown = preview?.type === "trim" ? { ...clip, ...preview.patch } : clip;
    const moving = preview?.type === "move" && preview.moved;
    const left = (moving ? preview.start : shown.start) * zoom;
    const width = Math.max(4, clipDuration(shown) * zoom);
    const isAudio = asset.kind === "audio";
    const waveHeight = isAudio ? height - 14 : asset.hasAudio && shown.freezeAt === null ? Math.round((height - 2) * settings.waveformRatio) : 0;
    const style: CSSProperties = { left, width, height: height - 4 };
    return <div key={clip.id} className={`timeline-clip ${isAudio ? "audio" : asset.kind}${selection.includes(clip.id) ? " selected" : ""}${moving ? " moving" : ""}${mode === "blade" ? " blade" : ""}`} style={style} onPointerDown={(event) => startClipPointer(event, clip, track)}>
      {!isAudio && <Filmstrip asset={asset} clip={shown} width={width} height={height - 4 - waveHeight} />}
      {waveHeight > 0 && <div className="clip-wave" style={{ height: waveHeight }}><Waveform asset={asset} clip={shown} width={width} height={waveHeight} /></div>}
      <span className="clip-label">{shown.freezeAt !== null && <em>定格</em>}{shown.reverse && <em>倒放</em>}{shown.speed !== 1 && <em>{shown.speed}×</em>}{shown.audio.muted && <em>静音</em>}{asset.name.replace(/\.[^.]+$/, "")}<small>{clipDuration(shown).toFixed(1)}s</small></span>
      {!track.locked && <><i className="clip-edge left" data-edge="left" /><i className="clip-edge right" data-edge="right" /></>}
    </div>;
  }

  const showNewZones = Boolean(draggingAssetId || (drag?.type === "move" && drag.moved));
  const movingTarget = drag?.type === "move" && drag.moved ? drag.target : null;
  const movingClip = drag?.type === "move" ? project.clips.find((clip) => clip.id === drag.clipId) : undefined;

  function newZone(position: "new-top" | "new-bottom") {
    const active = assetDrop?.target === position || movingTarget === position;
    const ghostLength = ghostAsset ? ghostAsset.duration : movingClip ? clipDuration(movingClip) : 0;
    const start = assetDrop?.target === position ? assetDrop.start : drag?.type === "move" ? drag.start : 0;
    return <div className={`timeline-row new-track${showNewZones ? " visible" : ""}${active ? " over" : ""}`} data-drop={position} onDragOver={(event) => onLaneDragOver(event, position)} onDragLeave={() => setAssetDrop(null)} onDrop={(event) => onLaneDrop(event, position)}>
      <div className="track-header"><small>{position === "new-top" ? "拖到这里新建画中画轨" : "拖到这里新建轨道"}</small></div>
      <div className="track-lane" style={{ width: contentWidth }}>{active && ghostLength > 0 && <i className="drop-ghost" style={{ left: start * zoom, width: ghostLength * zoom }} />}</div>
    </div>;
  }

  return <div className="timeline-scroll" ref={scrollRef} onPointerLeave={() => props.onHover(null)} onPointerMove={(event) => { if (toggles.previewAxis && !drag) props.onHover(timeFromClientX(event.clientX)); }}>
    <div className="timeline-content" style={{ width: contentWidth + headerWidth }}>
      <div className="timeline-ruler" onPointerDown={(event) => { if (event.button !== 0) return; props.onSeek(timeFromClientX(event.clientX)); beginDrag({ type: "scrub" }); }}>
        <div className="track-header ruler-corner"><span>{formatClock(time)}</span></div>
        <div className="ruler-lane" style={{ width: contentWidth }}>
          {ticks.map((tick) => <span key={tick} style={{ left: tick * zoom }}>{step < 1 ? `${tick.toFixed(1)}s` : formatClock(tick, false)}</span>)}
          {project.markers.map((marker) => <button key={marker.id} className="timeline-marker" style={{ left: marker.time * zoom }} title="标记（右键删除）" onPointerDown={(event) => { event.stopPropagation(); props.onSeek(marker.time); }} onContextMenu={(event) => { event.preventDefault(); props.onRemoveMarker(marker.id); }}><Icon name="marker" size={11} /></button>)}
        </div>
      </div>
      {newZone("new-top")}
      {rows.map((track) => {
        const height = track.kind === "audio" ? settings.audioHeight : track.main ? settings.videoHeight + 8 : settings.videoHeight;
        const over = assetDrop?.target === track.id || (movingTarget === track.id && movingClip?.trackId !== track.id);
        const ghostLength = ghostAsset ? ghostAsset.duration : movingClip ? clipDuration(movingClip) : 0;
        return <div key={track.id} className={`timeline-row ${track.kind}${track.main ? " main" : ""}${over ? " over" : ""}${track.hidden ? " hidden-track" : ""}`} style={{ height }} data-drop={track.id}>
          <div className="track-header">
            {track.main && <button className="cover-button" onClick={props.onCover} title="编辑封面" style={coverImage ? { backgroundImage: `url("${coverImage}")` } : undefined}><span>封面</span></button>}
            <span className="track-name"><Icon name={track.kind === "audio" ? "music" : track.main ? "film" : "image"} size={12} />{track.main ? "主轨" : track.kind === "audio" ? "音频" : "画中画"}</span>
            <span className="track-actions">
              <button title={track.locked ? "解锁轨道" : "锁定轨道"} className={track.locked ? "on" : ""} onClick={() => props.onTrack(track.id, { locked: !track.locked })}><Icon name={track.locked ? "lock" : "unlock"} size={12} /></button>
              {track.kind === "video" && <button title={track.hidden ? "显示轨道" : "隐藏轨道"} className={track.hidden ? "on" : ""} onClick={() => props.onTrack(track.id, { hidden: !track.hidden })}><Icon name={track.hidden ? "eyeOff" : "eye"} size={12} /></button>}
              <button title={track.muted ? "取消静音" : "静音轨道"} className={track.muted ? "on" : ""} onClick={() => props.onTrack(track.id, { muted: !track.muted })}><Icon name={track.muted ? "mute" : "volume"} size={12} /></button>
            </span>
          </div>
          <div className="track-lane" style={{ width: contentWidth }} onPointerDown={(event) => { if (event.button !== 0) return; props.onSelect([]); props.onSeek(timeFromClientX(event.clientX)); }} onDragOver={(event) => onLaneDragOver(event, track.id)} onDragLeave={() => setAssetDrop(null)} onDrop={(event) => onLaneDrop(event, track.id)}>
            {project.clips.filter((clip) => clip.trackId === track.id && !(drag?.type === "move" && drag.moved && drag.clipId === clip.id && drag.target !== track.id)).map((clip) => renderClip(clip, track, height))}
            {movingClip && movingTarget === track.id && movingClip.trackId !== track.id && renderClip(movingClip, track, height)}
            {assetDrop?.target === track.id && ghostLength > 0 && <i className="drop-ghost" style={{ left: assetDrop.start * zoom, width: ghostLength * zoom }} />}
            {!project.clips.some((clip) => clip.trackId === track.id) && track.main && !assetDrop && <span className="lane-hint">从左侧素材库拖入视频或图片</span>}
          </div>
        </div>;
      })}
      {newZone("new-bottom")}
      <div className="timeline-playhead" style={{ left: headerWidth + time * zoom }}><i /></div>
      {toggles.previewAxis && hoverTime !== null && !drag && <div className="timeline-hoverline" style={{ left: headerWidth + hoverTime * zoom }}><span>{formatClock(hoverTime)}</span></div>}
    </div>
  </div>;
}
