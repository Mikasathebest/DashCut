"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./editor/icons";
import { Inspector, InspectorTab } from "./editor/Inspector";
import { buildFilmstrip, captureFrame, probeFile } from "./editor/media";
import {
  addTrack, Asset, Clip, clipAt, clipDuration, clipEnd, createClip, defaultClipSettings, deleteClips, EditOptions, freezeFrame, hasRoom,
  mainTrack, placeClip, Project, projectDuration, pruneTracks, replaceWithRanges, sourceRangeToTimeline, sourceTimeAt, splitAtSourceTimes, splitClip,
  Subtitle, toComposition, trackClips, trimAt, uid, updateClip, createProject,
} from "./editor/model";
import { Preview, SubtitleStyle } from "./editor/Preview";
import { DropTarget, formatClock, Timeline, TimelineMode, TimelineSettings, TimelineToolbar, Toggles, ToolbarAction } from "./editor/Timeline";

type LeftTab = "media" | "subtitles";
type MediaFilter = "all" | "video" | "image" | "audio";
type RecognitionEngine = "cloud" | "local";
type History = { past: Project[]; present: Project; future: Project[]; key: string; at: number };

const defaultSubtitleStyle: SubtitleStyle = {
  fontFamily: 'Arial, "PingFang SC", "Microsoft YaHei", sans-serif',
  fontSize: 34,
  color: "#ffffff",
  outlineColor: "#111111",
  outlineWidth: 2,
  backgroundOpacity: 35,
};
const kindLabels: Record<Asset["kind"], string> = { video: "视频", image: "图片", gif: "动图", audio: "音频" };
const freezeLength = 3;

function isTyping(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return Boolean(element?.closest("input, textarea, select, [contenteditable=true]"));
}

export default function Home() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [history, setHistory] = useState<History>(() => ({ past: [], present: createProject(), future: [], key: "", at: 0 }));
  const project = history.present;
  const [selection, setSelection] = useState<string[]>([]);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);
  const [ratio, setRatio] = useState<"16:9" | "9:16">("16:9");
  const [leftTab, setLeftTab] = useState<LeftTab>("media");
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("all");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("picture");
  const [mode, setMode] = useState<TimelineMode>("select");
  const [toggles, setToggles] = useState<Toggles>({ magnet: true, snap: true, linkage: true, previewAxis: false });
  const [zoom, setZoom] = useState(40);
  const [viewportWidth, setViewportWidth] = useState(900);
  const [timelineSettings, setTimelineSettings] = useState<TimelineSettings>({ videoHeight: 58, audioHeight: 42, waveformRatio: 0.3 });
  const [draggingAssetId, setDraggingAssetId] = useState<string | null>(null);
  const [recording, setRecording] = useState<"idle" | number | "recording">("idle");
  const [cropOpen, setCropOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [subtitleMode, setSubtitleMode] = useState<"zh" | "en" | "both">("both");
  const [isGenerating, setIsGenerating] = useState(false);
  const [coverOpen, setCoverOpen] = useState(false);
  const [coverImage, setCoverImage] = useState("");
  const [coverBackground, setCoverBackground] = useState("");
  const [aboutOpen, setAboutOpen] = useState(false);
  const [coverTitle, setCoverTitle] = useState("独自旅行的 48 小时");
  const [coverAccent, setCoverAccent] = useState("#ffcc45");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFps, setExportFps] = useState<30 | 60>(60);
  const [exportResolution, setExportResolution] = useState<720 | 1080 | 2160>(1080);
  const [platform, setPlatform] = useState<"bilibili" | "youtube">("bilibili");
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressStage, setProgressStage] = useState("");
  const [exportResult, setExportResult] = useState<{ outputPath: string; subtitleFiles: string[] } | null>(null);
  const [toast, setToast] = useState("");
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyle>(defaultSubtitleStyle);
  const [styleOpen, setStyleOpen] = useState(false);
  const [recognitionEngine, setRecognitionEngine] = useState<RecognitionEngine>("local");
  const [hardwareOpen, setHardwareOpen] = useState(false);
  const [hardware, setHardware] = useState<HardwareProfile | null>(null);
  const [checkingHardware, setCheckingHardware] = useState(false);
  const [localModels, setLocalModels] = useState<LocalModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<LocalModelInfo["id"]>("small");
  const [installingModel, setInstallingModel] = useState<string>("");
  const [hubConfig, setHubConfig] = useState<HubConfig>({ baseUrl: "https://api.example.com/v1", apiKey: "", model: "qwen3-next-80b-a3b-instruct" });
  const [hubAudioModel, setHubAudioModel] = useState("us/gcp/google/gemini-2.5-flash");
  const [hubModels, setHubModels] = useState<HubModel[]>([]);
  const [loadingHubModels, setLoadingHubModels] = useState(false);
  const [autoTranslate, setAutoTranslate] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const currentRef = useRef(0);
  const recorderRef = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; start: number } | null>(null);

  const assetMap = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const duration = projectDuration(project);
  const options: EditOptions = useMemo(() => ({ magnet: toggles.magnet, linkage: toggles.linkage }), [toggles.magnet, toggles.linkage]);
  const selectedClips = project.clips.filter((clip) => selection.includes(clip.id));
  const primaryClip = selectedClips.at(-1) ?? null;
  const primaryAsset = primaryClip ? assetMap.get(primaryClip.assetId) ?? null : null;
  const previewTime = !playing && toggles.previewAxis && hoverTime !== null ? hoverTime : current;
  const usedAssets = useMemo(() => new Set(project.clips.map((clip) => clip.assetId)), [project.clips]);

  /* ------------------------------------------------------------ history */

  const commit = useCallback((next: Project | ((project: Project) => Project), key = "") => {
    setHistory((state) => {
      const value = typeof next === "function" ? next(state.present) : next;
      if (value === state.present) return state;
      const now = Date.now();
      // Continuous slider drags collapse into one undo step.
      if (key && key === state.key && now - state.at < 1200) return { ...state, present: value, future: [], at: now };
      return { past: [...state.past.slice(-99), state.present], present: value, future: [], key, at: now };
    });
  }, []);

  function undo() {
    setHistory((state) => state.past.length ? { past: state.past.slice(0, -1), present: state.past.at(-1)!, future: [state.present, ...state.future], key: "", at: 0 } : state);
  }

  function redo() {
    setHistory((state) => state.future.length ? { past: [...state.past, state.present], present: state.future[0], future: state.future.slice(1), key: "", at: 0 } : state);
  }

  /* ------------------------------------------------------------ playback clock */

  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = currentRef.current + (now - last) / 1000;
      last = now;
      if (next >= duration && !recorderRef.current) {
        currentRef.current = duration;
        setCurrent(duration);
        setPlaying(false);
        return;
      }
      currentRef.current = next;
      setCurrent(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [duration, playing]);

  function seek(time: number) {
    const next = Math.max(0, Math.min(Math.max(duration, 0), time));
    currentRef.current = next;
    setCurrent(next);
  }

  function togglePlay() {
    if (!project.clips.length) return;
    if (!playing && current >= duration - 0.02) seek(0);
    setPlaying(!playing);
  }

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    if (!window.dashCutDesktop) return;
    return window.dashCutDesktop.onExportProgress(({ progress: nextProgress, stage }) => {
      setProgress(nextProgress);
      setProgressStage(stage);
    });
  }, []);

  /* ------------------------------------------------------------ import */

  function patchAsset(id: string, patch: Partial<Asset>) {
    setAssets((items) => items.map((asset) => asset.id === id ? { ...asset, ...patch } : asset));
  }

  async function importFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    setLeftTab("media");
    // Probe sequentially so the library keeps the user's selection order.
    const imported: Asset[] = [];
    for (const file of files) {
      const asset = await probeFile(file, window.dashCutDesktop?.getFilePath(file) ?? "");
      if (asset) imported.push(asset);
    }
    const skipped = files.length - imported.length;
    if (!imported.length) return setToast("无法读取所选素材");
    setAssets((items) => [...items, ...imported]);
    setToast(`已导入 ${imported.length} 个素材${skipped ? `，${skipped} 个文件无法读取` : ""}，拖到时间轴开始剪辑`);
    for (const asset of imported) {
      if (asset.kind === "video") void buildFilmstrip(asset).then((frames) => patchAsset(asset.id, { frames }));
      if ((asset.kind === "video" || asset.kind === "audio") && window.dashCutDesktop && asset.sourcePath) {
        void window.dashCutDesktop.extractWaveform(asset.sourcePath).then((wave) => patchAsset(asset.id, { peaks: wave.peaks, peaksPerSecond: wave.peaksPerSecond, hasAudio: wave.peaks.length > 0 })).catch(() => undefined);
      }
    }
  }

  function removeAsset(asset: Asset) {
    if (usedAssets.has(asset.id)) return setToast("素材正在时间轴中使用，请先删除对应片段");
    URL.revokeObjectURL(asset.url);
    setAssets((items) => items.filter((item) => item.id !== asset.id));
  }

  /* ------------------------------------------------------------ placement */

  /** Resolves a drop target to a concrete track, creating one when needed. */
  function resolveTrack(base: Project, target: DropTarget, kind: "video" | "audio", start: number, length: number, ignoreId?: string) {
    let next = base;
    let trackId = target;
    if (target === "new-top" || target === "new-bottom") {
      const created = addTrack(next, kind, kind === "audio" ? "bottom" : target === "new-top" ? "top" : "bottom");
      next = created.project;
      trackId = created.trackId;
      // A new video track dropped below is placed directly above the main track.
      if (kind === "video" && target === "new-bottom") {
        const tracks = next.tracks.filter((track) => track.id !== trackId);
        const mainIndex = tracks.findIndex((track) => track.main);
        tracks.splice(mainIndex, 0, next.tracks.find((track) => track.id === trackId)!);
        next = { ...next, tracks };
      }
    }
    const track = next.tracks.find((item) => item.id === trackId);
    if (!track || track.kind !== kind) {
      const fallback = next.tracks.find((item) => item.kind === kind && !item.locked && (item.main || hasRoom(next, item.id, start, length, ignoreId)));
      if (fallback) return { project: next, trackId: fallback.id };
      const created = addTrack(next, kind, kind === "audio" ? "bottom" : "top");
      return { project: created.project, trackId: created.trackId };
    }
    // Overlapping a non-main track bumps the clip onto a fresh track, like other editors.
    if (!track.main && !hasRoom(next, track.id, start, length, ignoreId)) {
      const created = addTrack(next, kind, kind === "audio" ? "bottom" : "top");
      const tracks = created.project.tracks.filter((item) => item.id !== created.trackId);
      const index = tracks.findIndex((item) => item.id === track.id);
      tracks.splice(kind === "audio" ? index + 1 : index, 0, created.project.tracks.find((item) => item.id === created.trackId)!);
      return { project: { ...created.project, tracks }, trackId: created.trackId };
    }
    return { project: next, trackId };
  }

  function dropAsset(assetId: string, target: DropTarget, start: number) {
    const asset = assetMap.get(assetId);
    setDraggingAssetId(null);
    if (!asset) return;
    const kind = asset.kind === "audio" ? "audio" : "video";
    const resolved = resolveTrack(project, target, kind, start, asset.duration);
    const clip = createClip(asset, resolved.trackId, start);
    commit(pruneTracks(placeClip(resolved.project, clip, resolved.trackId, start, options)));
    setSelection([clip.id]);
  }

  function appendAsset(asset: Asset) {
    const kind = asset.kind === "audio" ? "audio" : "video";
    if (kind === "video") return dropAsset(asset.id, mainTrack(project).id, projectDuration(project) + 1);
    const track = project.tracks.find((item) => item.kind === "audio" && hasRoom(project, item.id, current, asset.duration));
    dropAsset(asset.id, track?.id ?? "new-bottom", current);
  }

  function moveClip(clipId: string, target: DropTarget, start: number) {
    const clip = project.clips.find((item) => item.id === clipId);
    const asset = clip && assetMap.get(clip.assetId);
    if (!clip || !asset) return;
    const kind = asset.kind === "audio" ? "audio" : "video";
    const resolved = resolveTrack(project, target, kind, start, clipDuration(clip), clip.id);
    commit(pruneTracks(placeClip(resolved.project, clip, resolved.trackId, start, options)));
  }

  function trimClip(clipId: string, patch: Partial<Clip>) {
    const clip = project.clips.find((item) => item.id === clipId);
    if (!clip) return;
    const next = { ...clip, ...patch };
    const track = project.tracks.find((item) => item.id === clip.trackId);
    if (!(track?.main && toggles.magnet) && !hasRoom(project, clip.trackId, next.start, clipDuration(next), clip.id)) return setToast("与同轨道的片段重叠，请先移动相邻片段");
    commit(updateClip(project, clipId, patch, options));
  }

  /* ------------------------------------------------------------ toolbar actions */

  function targetsAtPlayhead() {
    const selected = selectedClips.filter((clip) => current > clip.start && current < clipEnd(clip));
    if (selected.length) return selected;
    const main = clipAt(project, mainTrack(project).id, current);
    return main ? [main] : [];
  }

  function splitAtPlayhead() {
    const targets = targetsAtPlayhead().filter((clip) => !project.tracks.find((track) => track.id === clip.trackId)?.locked);
    if (!targets.length) return setToast("请把播放头移到要分割的片段上");
    let next = project;
    let lastRight: string | null = null;
    for (const clip of targets) {
      const result = splitClip(next, clip.id, current);
      next = result.project;
      lastRight = result.rightId ?? lastRight;
    }
    if (next === project) return setToast("播放头离片段边缘太近");
    commit(next);
    if (lastRight) setSelection([lastRight]);
  }

  function bladeSplit(clipId: string, time: number) {
    const result = splitClip(project, clipId, time);
    if (!result.rightId) return;
    commit(result.project);
    setSelection([result.rightId]);
  }

  function patchSelected(patch: (clip: Clip) => Partial<Clip>, key = "") {
    if (!selectedClips.length) return setToast("请先在时间轴上选择片段");
    commit(selectedClips.reduce((value, clip) => updateClip(value, clip.id, patch(clip), options), project), key);
  }

  async function smartTalk() {
    const clip = primaryClip;
    const asset = primaryAsset;
    if (!clip || !asset) return setToast("请先选择一个口播视频或音频片段");
    if (!window.dashCutDesktop) return setToast("智能剪口播仅支持桌面版");
    if (!asset.hasAudio || clip.freezeAt !== null) return setToast("该片段没有音频，无法智能剪口播");
    if (clip.reverse) return setToast("请先取消倒放再智能剪口播");
    setBusy("正在分析停顿…");
    try {
      const { speech } = await window.dashCutDesktop.detectSpeechSegments(asset.sourcePath, { in: clip.in, out: clip.out });
      const removed = (clip.out - clip.in) - speech.reduce((sum, range) => sum + range.end - range.start, 0);
      if (!speech.length) return setToast("没有检测到人声");
      if (removed < 0.2) return setToast("没有可剪掉的停顿");
      commit((state) => replaceWithRanges(state, clip.id, speech, options));
      setToast(`已剪掉 ${removed.toFixed(1)} 秒停顿，保留 ${speech.length} 段人声`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "智能剪口播失败");
    } finally {
      setBusy("");
    }
  }

  async function smartScenes() {
    const clip = primaryClip;
    const asset = primaryAsset;
    if (!clip || asset?.kind !== "video" || clip.freezeAt !== null) return setToast("请先选择一个视频片段");
    if (!window.dashCutDesktop) return setToast("智能镜头分割仅支持桌面版");
    setBusy("正在识别镜头切换…");
    try {
      const cuts = await window.dashCutDesktop.detectScenes(asset.sourcePath, { in: clip.in, out: clip.out });
      if (!cuts.length) return setToast("没有检测到镜头切换");
      commit((state) => splitAtSourceTimes(state, clip.id, cuts));
      setToast(`已按镜头切换分割为 ${cuts.length + 1} 段`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "镜头分割失败");
    } finally {
      setBusy("");
    }
  }

  async function toggleRecording() {
    if (recorderRef.current) {
      recorderRef.current.recorder.stop();
      return;
    }
    if (recording !== "idle") return;
    if (!navigator.mediaDevices?.getUserMedia) return setToast("当前环境不支持录音");
    if (window.dashCutDesktop && !(await window.dashCutDesktop.requestMicrophone())) return setToast("请在系统设置 → 隐私与安全性 → 麦克风中允许 DashCut");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      return setToast("无法打开麦克风");
    }
    for (const count of [3, 2, 1]) {
      setRecording(count);
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
    const recorder = new MediaRecorder(stream, MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? { mimeType: "audio/webm;codecs=opus" } : undefined);
    const session = { recorder, stream, chunks: [] as Blob[], start: currentRef.current };
    recorderRef.current = session;
    recorder.ondataavailable = (event) => { if (event.data.size) session.chunks.push(event.data); };
    recorder.onstop = () => void finishRecording(session);
    recorder.start(250);
    setRecording("recording");
    setPlaying(true);
  }

  async function finishRecording(session: { stream: MediaStream; chunks: Blob[]; start: number }) {
    session.stream.getTracks().forEach((track) => track.stop());
    recorderRef.current = null;
    setRecording("idle");
    setPlaying(false);
    const blob = new Blob(session.chunks, { type: "audio/webm" });
    if (blob.size < 1000) return setToast("录音太短");
    const elapsed = Math.max(0.5, currentRef.current - session.start);
    const name = `录音 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}.webm`;
    const sourcePath = window.dashCutDesktop ? await window.dashCutDesktop.saveRecording(await blob.arrayBuffer()) : "";
    const probed = await probeFile(new File([blob], name, { type: "audio/webm" }), sourcePath);
    // MediaRecorder WebM often reports no duration; fall back to the recorded wall time.
    const recorded: Asset = probed && Number.isFinite(probed.duration) && probed.duration > 0
      ? probed
      : { id: uid("asset"), name, kind: "audio", url: URL.createObjectURL(blob), sourcePath, duration: elapsed, width: 0, height: 0, hasAudio: true, thumbnail: "", frames: [], peaks: [], peaksPerSecond: 0 };
    setAssets((items) => [...items, recorded]);
    if (window.dashCutDesktop && sourcePath) void window.dashCutDesktop.extractWaveform(sourcePath).then((wave) => patchAsset(recorded.id, { peaks: wave.peaks, peaksPerSecond: wave.peaksPerSecond })).catch(() => undefined);
    commit((state) => {
      const track = state.tracks.find((item) => item.kind === "audio" && hasRoom(state, item.id, session.start, recorded.duration));
      const created = track ? null : addTrack(state, "audio", "bottom");
      const base = created ? created.project : state;
      const clip = createClip(recorded, track?.id ?? created!.trackId, session.start);
      return pruneTracks({ ...base, clips: [...base.clips, clip] });
    });
    setToast("录音已添加到音频轨");
  }

  function runAction(action: ToolbarAction) {
    if (isGenerating && !["import", "fit", "record"].includes(action)) return setToast("请等待字幕生成完成后再编辑时间线");
    switch (action) {
      case "import": return fileInputRef.current?.click();
      case "undo": return undo();
      case "redo": return redo();
      case "reset": {
        const defaults = defaultClipSettings();
        return patchSelected((clip) => ({ ...defaults, freezeAt: clip.freezeAt, speed: 1 }));
      }
      case "split": return splitAtPlayhead();
      case "trim-left":
      case "trim-right": {
        const targets = selectedClips.filter((clip) => current > clip.start && current < clipEnd(clip));
        if (!targets.length) return setToast("请选择片段并把播放头移到片段内");
        commit(targets.reduce((value, clip) => trimAt(value, clip.id, current, action === "trim-left" ? "left" : "right", options), project));
        if (action === "trim-left" && toggles.magnet && project.tracks.find((track) => track.id === targets[0].trackId)?.main) seek(targets[0].start);
        return;
      }
      case "delete":
        if (!selectedClips.length) return;
        commit(pruneTracks(deleteClips(project, selection, options)));
        return setSelection([]);
      case "marker": {
        const existing = project.markers.find((marker) => Math.abs(marker.time - current) < 0.05);
        return commit({ ...project, markers: existing ? project.markers.filter((marker) => marker.id !== existing.id) : [...project.markers, { id: uid("marker"), time: current }] });
      }
      case "freeze": {
        const clip = primaryClip;
        if (!clip || primaryAsset?.kind !== "video" || clip.freezeAt !== null) return setToast("请选择一个视频片段");
        if (current < clip.start || current > clipEnd(clip)) return setToast("请把播放头移到所选视频片段上");
        const result = freezeFrame(project, clip.id, current, freezeLength, options);
        commit(result.project);
        if (result.freezeId) setSelection([result.freezeId]);
        return setToast(`已在 ${formatClock(current)} 定格 ${freezeLength} 秒`);
      }
      case "reverse": return patchSelected((clip) => ({ reverse: !clip.reverse }));
      case "mirror": return patchSelected((clip) => ({ mirror: !clip.mirror }));
      case "rotate": return patchSelected((clip) => ({ rotate90: ((clip.rotate90 + 90) % 360) as Clip["rotate90"] }));
      case "crop":
        if (!primaryClip || primaryAsset?.kind === "audio") return setToast("请选择一个画面片段");
        return setCropOpen(true);
      case "smart-extend": return setToast("智能延长需要生成式视频模型，即将推出");
      case "smart-rough": return setToast("智能粗剪即将推出");
      case "smart-talk": return void smartTalk();
      case "smart-scenes": return void smartScenes();
      case "record": return void toggleRecording();
      case "fit": return setZoom(Math.max(2, Math.min(400, viewportWidth / Math.max(duration * 1.05, 5))));
    }
  }

  const actionRef = useRef(runAction);
  useEffect(() => { actionRef.current = runAction; });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      const meta = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const map: Record<string, ToolbarAction | "play" | "select" | "blade"> = meta
        ? { z: event.shiftKey ? "redo" : "undo", y: "redo", b: "split" }
        : { " ": "play", backspace: "delete", delete: "delete", m: "marker", q: "trim-left", w: "trim-right", a: "select", b: "blade" };
      const action = map[key];
      if (!action) return;
      event.preventDefault();
      if (action === "play") return document.querySelector<HTMLButtonElement>("[data-play-toggle]")?.click();
      if (action === "select" || action === "blade") return setMode(action);
      actionRef.current(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ------------------------------------------------------------ captions */

  function captionSources() {
    const used = assets.filter((asset) => asset.kind !== "image" && asset.kind !== "gif" && asset.hasAudio && asset.sourcePath && project.clips.some((clip) => clip.assetId === asset.id && clip.freezeAt === null && !clip.reverse && !clip.audio.muted));
    return used.map((asset, index) => ({ asset, id: index + 1 }));
  }

  function placeCaptions(sources: Array<{ asset: Asset; id: number }>, results: Array<{ clipId: number; segments: Array<{ start: number; end: number; text: string; zh?: string; en?: string; words?: Array<{ start: number; end: number; word: string }> }> }>, cloud: boolean) {
    const generated: Subtitle[] = [];
    for (const result of results) {
      const asset = sources.find((source) => source.id === result.clipId)?.asset;
      if (!asset) continue;
      for (const clip of project.clips.filter((item) => item.assetId === asset.id && !item.audio.muted)) {
        for (const caption of result.segments) {
          const range = sourceRangeToTimeline(clip, caption.start, caption.end);
          if (!range) continue;
          if (cloud) {
            generated.push({ id: 0, start: range.start, end: range.end, zh: caption.zh ?? "", en: caption.en ?? "" });
            continue;
          }
          // Clip word timestamps at cuts instead of repeating the full utterance.
          const text = caption.words?.length ? caption.words.filter((word) => (word.start + word.end) / 2 >= range.sourceStart && (word.start + word.end) / 2 < range.sourceEnd).map((word) => word.word).join("").trim() : caption.text;
          if (!text) continue;
          const isChinese = /[㐀-鿿]/u.test(text);
          generated.push({ id: 0, start: range.start, end: range.end, zh: isChinese ? text : "", en: isChinese ? "" : text });
        }
      }
    }
    return generated.sort((a, b) => a.start - b.start).map((item, index) => ({ ...item, id: index + 1 }));
  }

  function setSubtitles(subtitles: Subtitle[], key = "") {
    commit((state) => ({ ...state, subtitles }), key);
  }

  async function generateSubtitles() {
    if (isGenerating) return;
    if (recognitionEngine === "cloud" || autoTranslate) {
      if (!window.dashCutDesktop) return setToast("AI API 字幕仅支持桌面版");
      if (!hubConfig.apiKey.trim()) return setToast("请先填写 AI API API Key，或关闭云端翻译以离线识别");
    }
    const sources = captionSources();
    if (recognitionEngine === "local") {
      if (!window.dashCutDesktop) {
        setToast("本地识别仅支持桌面版");
        setHardwareOpen(true);
        return;
      }
      if (!hardware?.runtime?.ready) {
        setToast("本地 AI 运行时不可用，请重新安装 DashCut 极剪");
        setHardwareOpen(true);
        void checkHardware();
        return;
      }
      if (!localModels.find((model) => model.id === selectedModel)?.installed) {
        setToast(`请先下载安装 ${selectedModel} 模型`);
        setHardwareOpen(true);
        return;
      }
      if (!sources.length) return setToast("时间轴中没有含人声的视频或音频");
      setIsGenerating(true);
      try {
        const useCuda = Boolean(hardware.gpus.some((gpu) => gpu.fasterWhisperAcceleration) && Number(hardware.runtime.info?.cudaDeviceCount) > 0);
        const response = await window.dashCutDesktop.transcribeLocal({
          clips: sources.map((source) => ({ id: source.id, path: source.asset.sourcePath })),
          model: selectedModel,
          device: useCuda ? "cuda" : "cpu",
          computeType: hardware.assessment.computeType,
        });
        const generated = placeCaptions(sources, response.results, false);
        setSubtitles(generated);
        if (autoTranslate && generated.length) {
          setToast("本地识别完成，正在生成中英译文…");
          try {
            setSubtitles(await window.dashCutDesktop.translateSubtitles({ config: hubConfig, subtitles: generated }));
            setToast(`双语字幕完成 · ${response.model} + AI API（保留识别时间戳）`);
          } catch (error) {
            setToast(`已保留原语言字幕；翻译失败：${error instanceof Error ? error.message : "请重试"}`);
          }
        } else setToast(`本地识别完成 · ${response.model} / ${response.device}`);
      } catch (error) {
        setToast(error instanceof Error ? error.message : "本地识别失败");
      } finally {
        setIsGenerating(false);
      }
      return;
    }
    if (!window.dashCutDesktop) return;
    if (!sources.length) return setToast("时间轴中没有含人声的视频或音频");
    setIsGenerating(true);
    try {
      const response = await window.dashCutDesktop.transcribeHub({ config: { ...hubConfig, model: hubAudioModel }, clips: sources.map((source) => ({ id: source.id, path: source.asset.sourcePath })) });
      setSubtitles(placeCaptions(sources, response.results, true));
      setToast("云端双语字幕完成，时间为模型估算，请试听校准；准确同步建议本地 Whisper + 云端翻译");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "云端识别失败");
    } finally { setIsGenerating(false); }
  }

  async function refreshHubModels() {
    if (!window.dashCutDesktop) return setToast("模型查询仅支持桌面版");
    setLoadingHubModels(true);
    try {
      const models = await window.dashCutDesktop.listHubModels(hubConfig);
      setHubModels(models);
      setToast(`已查询 ${models.length} 个模型；模型列表不保证音频支持`);
    } catch (error) { setToast(error instanceof Error ? error.message : "模型查询失败"); }
    finally { setLoadingHubModels(false); }
  }

  async function translateExistingSubtitles() {
    if (!window.dashCutDesktop || isGenerating || !project.subtitles.length) return;
    setIsGenerating(true);
    try {
      setSubtitles(await window.dashCutDesktop.translateSubtitles({ config: hubConfig, subtitles: project.subtitles }));
      setToast("中英译文已更新，字幕时间保持不变");
    } catch (error) { setToast(error instanceof Error ? error.message : "翻译失败，原字幕已保留"); }
    finally { setIsGenerating(false); }
  }

  function updateSubtitleTime(id: number, field: "start" | "end", value: number) {
    const subtitle = project.subtitles.find((item) => item.id === id);
    if (!subtitle || !Number.isFinite(value) || value < 0 || value > duration || (field === "start" ? value >= subtitle.end : value <= subtitle.start)) {
      setToast("字幕时间必须在时间线范围内，结束时间大于开始时间");
      return false;
    }
    setSubtitles(project.subtitles.map((item) => item.id === id ? { ...item, [field]: value } : item).sort((a, b) => a.start - b.start));
    return true;
  }

  function updateSubtitle(id: number, field: "zh" | "en", value: string) {
    setSubtitles(project.subtitles.map((item) => item.id === id ? { ...item, [field]: value } : item), `subtitle-${id}-${field}`);
  }

  async function checkHardware() {
    setHardwareOpen(true);
    if (!window.dashCutDesktop) {
      setHardware(null);
      return;
    }
    setCheckingHardware(true);
    try {
      const [profile, models] = await Promise.all([
        window.dashCutDesktop.getHardwareProfile(),
        window.dashCutDesktop.getLocalModels(),
      ]);
      setHardware(profile);
      setLocalModels(models);
      if (["small", "medium", "turbo", "large-v3"].includes(profile.assessment.model)) {
        setSelectedModel(profile.assessment.model as LocalModelInfo["id"]);
      }
    } catch {
      setToast("硬件检测失败，请重新启动桌面应用");
    } finally {
      setCheckingHardware(false);
    }
  }

  async function installLocalModel(model: LocalModelInfo["id"]) {
    if (!window.dashCutDesktop) return;
    setInstallingModel(model);
    try {
      await window.dashCutDesktop.installLocalModel(model);
      setLocalModels(await window.dashCutDesktop.getLocalModels());
      setSelectedModel(model);
      setToast(`${model} 模型安装完成`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : `${model} 模型安装失败`);
    } finally {
      setInstallingModel("");
    }
  }

  async function removeLocalModel(model: LocalModelInfo["id"]) {
    if (!window.dashCutDesktop) return;
    await window.dashCutDesktop.removeLocalModel(model);
    setLocalModels(await window.dashCutDesktop.getLocalModels());
    setToast(`${model} 模型已删除`);
  }

  function updateSubtitleStyle<K extends keyof SubtitleStyle>(key: K, value: SubtitleStyle[K]) {
    setSubtitleStyle((style) => ({ ...style, [key]: value }));
  }

  /* ------------------------------------------------------------ export & cover */

  async function startExport() {
    if (!window.dashCutDesktop) return setToast("真实视频导出仅支持桌面版");
    if (!project.clips.length) return setToast("请先把素材拖到时间轴");
    if (project.clips.some((clip) => !assetMap.get(clip.assetId)?.sourcePath)) return setToast("部分素材缺少本地路径，请重新导入");
    setExporting(true);
    setExportResult(null);
    setProgress(0);
    setProgressStage("正在准备导出");
    try {
      const request = toComposition(project, assets, { ratio, resolution: exportResolution, fps: exportFps, platform, subtitleStyle });
      const result = await window.dashCutDesktop.exportComposition(request);
      if (!result.canceled && result.outputPath) {
        setExportResult({ outputPath: result.outputPath, subtitleFiles: result.subtitleFiles ?? [] });
        setProgress(100);
        setProgressStage("导出完成");
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : "视频导出失败");
    } finally {
      setExporting(false);
    }
  }

  async function applyCurrentFrameToCover() {
    const main = mainTrack(project).id;
    const clip = clipAt(project, main, current) ?? trackClips(project, main)[0];
    const asset = clip && assetMap.get(clip.assetId);
    if (!clip || !asset) return setToast("主轨上没有画面");
    setCoverBackground(await captureFrame(asset, sourceTimeAt(clip, Math.max(current, clip.start))));
  }

  function renderCover(download = false) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = 1280;
    canvas.height = 720;
    const finish = () => {
      ctx.fillStyle = "rgba(8, 13, 25, .58)";
      ctx.fillRect(65, 68, 760, 575);
      ctx.fillStyle = coverAccent;
      ctx.fillRect(65, 68, 16, 575);
      ctx.fillStyle = "#ffffff";
      ctx.font = "800 72px Arial, sans-serif";
      const words = coverTitle.split(" ");
      const first = words.slice(0, Math.ceil(words.length / 2)).join(" ");
      const second = words.slice(Math.ceil(words.length / 2)).join(" ");
      ctx.fillText(first, 125, 285, 640);
      if (second) ctx.fillText(second, 125, 385, 640);
      ctx.fillStyle = coverAccent;
      ctx.font = "700 28px Arial, sans-serif";
      ctx.fillText("TRAVEL VLOG  ·  EP. 08", 126, 510);
      ctx.fillStyle = "rgba(255,255,255,.84)";
      ctx.font = "500 22px Arial, sans-serif";
      ctx.fillText("DASHCUT 极剪原创视频", 126, 565);
      if (download) {
        const data = canvas.toDataURL("image/png");
        setCoverImage(data);
        const link = document.createElement("a");
        link.href = data;
        link.download = "视频封面.png";
        link.click();
        setToast("封面图已保存");
      }
    };
    if (coverBackground) {
      const image = new Image();
      image.onload = () => {
        const scale = Math.max(1280 / image.width, 720 / image.height);
        ctx.drawImage(image, (1280 - image.width * scale) / 2, (720 - image.height * scale) / 2, image.width * scale, image.height * scale);
        finish();
      };
      image.src = coverBackground;
      return;
    }
    const bg = ctx.createLinearGradient(0, 0, 1280, 720);
    bg.addColorStop(0, "#173461");
    bg.addColorStop(0.55, "#2b6670");
    bg.addColorStop(1, "#e18b58");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 1280, 720);
    ctx.globalAlpha = 0.2;
    for (let i = 0; i < 11; i++) {
      ctx.fillStyle = i % 2 ? "#ffffff" : coverAccent;
      ctx.beginPath();
      ctx.arc(110 + i * 130, 120 + (i % 3) * 190, 80 + (i % 2) * 60, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    finish();
  }

  useEffect(() => {
    // Canvas drawing is an imperative synchronization with the cover editor.
    if (coverOpen) renderCover(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coverOpen, coverTitle, coverAccent, coverBackground]);

  const mainThumb = assetMap.get(trackClips(project, mainTrack(project).id)[0]?.assetId ?? "")?.thumbnail ?? "";
  const filteredAssets = assets.filter((asset) => mediaFilter === "all" || (mediaFilter === "image" ? asset.kind === "image" || asset.kind === "gif" : asset.kind === mediaFilter));
  const primaryId = primaryClip?.id;
  const changeClip = useCallback((patch: Partial<Clip>, key: string) => {
    if (!primaryId) return;
    commit((state) => updateClip(state, primaryId, patch, options), `${primaryId}-${key}`);
  }, [commit, options, primaryId]);

  /* ------------------------------------------------------------ render */

  const mediaPanel = <>
    <button className="upload-card" onClick={() => fileInputRef.current?.click()}><span>＋</span><strong>导入素材</strong><small>视频、图片、动图、音频可混合多选</small></button>
    <div className="media-filters">{(["all", "video", "image", "audio"] as const).map((filter) => <button key={filter} className={mediaFilter === filter ? "active" : ""} onClick={() => setMediaFilter(filter)}>{filter === "all" ? `全部 ${assets.length}` : filter === "image" ? "图片" : kindLabels[filter]}</button>)}</div>
    <div className="asset-grid">{filteredAssets.map((asset) => <div key={asset.id} className={`asset-card${usedAssets.has(asset.id) ? " used" : ""}`} draggable onDragStart={(event) => { event.dataTransfer.setData("application/x-dashcut-asset", asset.id); event.dataTransfer.effectAllowed = "copy"; setDraggingAssetId(asset.id); }} onDragEnd={() => setDraggingAssetId(null)} onDoubleClick={() => appendAsset(asset)} title="拖到时间轴，或双击添加到末尾">
      <div className="asset-thumb" style={asset.thumbnail ? { backgroundImage: `url("${asset.thumbnail}")` } : undefined}>
        {asset.kind === "audio" && <Icon name="music" size={22} />}
        <span className="asset-kind">{kindLabels[asset.kind]}</span>
        {asset.kind !== "image" && <span className="asset-duration">{formatClock(asset.duration, false)}</span>}
        {usedAssets.has(asset.id) && <span className="asset-used">已添加</span>}
        <button className="asset-add" title="添加到时间轴" onClick={() => appendAsset(asset)}><Icon name="plus" size={13} /></button>
        <button className="asset-remove" title="从素材库移除" onClick={() => removeAsset(asset)}>×</button>
      </div>
      <strong>{asset.name}</strong>
    </div>)}</div>
    {!assets.length && <p className="empty-hint">导入的素材会按导入顺序显示在这里，不会自动放入时间轴。把素材拖到时间轴的轨道上即可使用；拖到轨道上方的空白处会新建画中画轨，用来叠加图片和视频。</p>}
  </>;

  const subtitlesPanel = <>
    <div className="language-switch"><button className={subtitleMode === "zh" ? "active" : ""} onClick={() => setSubtitleMode("zh")}>中文</button><button className={subtitleMode === "en" ? "active" : ""} onClick={() => setSubtitleMode("en")}>English</button><button className={subtitleMode === "both" ? "active" : ""} onClick={() => setSubtitleMode("both")}>中英双语</button></div>
    <div className="engine-switch"><button className={recognitionEngine === "cloud" ? "active" : ""} onClick={() => setRecognitionEngine("cloud")}><b>☁</b><span>云端模型<small>速度快 · 需要网络</small></span></button><button className={recognitionEngine === "local" ? "active" : ""} onClick={() => { setRecognitionEngine("local"); void checkHardware(); }}><b>⌁</b><span>本地模型<small>离线 · 保护隐私</small></span></button></div>
    <details className="hub-settings">
      <summary>AI API · 中英字幕</summary>
      <p>准确同步推荐：本地 Whisper large-v3 + 云端翻译。云端识别时间为估算，可手动校准。</p>
      <label>API base URL<input value={hubConfig.baseUrl} disabled={isGenerating || loadingHubModels} onChange={(event) => { setHubModels([]); setHubConfig({ ...hubConfig, baseUrl: event.target.value }); }} /></label>
      <label>API Key（仅本次会话）<input type="password" autoComplete="off" value={hubConfig.apiKey} disabled={isGenerating || loadingHubModels} onChange={(event) => setHubConfig({ ...hubConfig, apiKey: event.target.value })} placeholder="输入密钥，不保存到磁盘" /></label>
      <button className="ghost-action" disabled={loadingHubModels || isGenerating} onClick={() => void refreshHubModels()}>{loadingHubModels ? "正在查询…" : `查询可用模型${hubModels.length ? ` (${hubModels.length})` : ""}`}</button>
      {recognitionEngine === "cloud" ? <label>音频识别模型<select value={hubAudioModel} disabled={isGenerating} onChange={(event) => setHubAudioModel(event.target.value)}><option value="us/gcp/google/gemini-2.5-flash">Gemini 2.5 Flash · 已测试音频</option><option value="us/gcp/google/gemini-3.5-flash">Gemini 3.5 Flash · 已测试音频</option></select></label> : <label className="hub-checkbox"><input type="checkbox" checked={autoTranslate} disabled={isGenerating} onChange={(event) => setAutoTranslate(event.target.checked)} />识别后自动生成中英译文</label>}
      <label>翻译模型<input list="hub-models" value={hubConfig.model} disabled={isGenerating} onChange={(event) => setHubConfig({ ...hubConfig, model: event.target.value })} /><datalist id="hub-models">{hubModels.filter((model) => model.mode === "chat").map((model) => <option key={model.id} value={model.id} />)}</datalist></label>
      <small>{recognitionEngine === "cloud" ? "生成时会将视频音轨发送到接口。" : autoTranslate ? "生成时仅将识别后的字幕文本发送到接口。" : "关闭自动翻译时，本地识别可离线运行。"}</small>
      <button className="ghost-action" disabled={isGenerating || !project.subtitles.length} onClick={() => void translateExistingSubtitles()}>翻译当前字幕 · 保留时间戳</button>
    </details>
    <button className="generate-button" onClick={generateSubtitles} disabled={isGenerating}><span>{isGenerating ? "◌" : "✦"}</span><strong>{isGenerating ? "正在识别人声…" : "识别字幕"}</strong><small>{isGenerating ? "正在分析音轨与语义" : "普通话 / English · 自动断句"}</small></button>
    <div className="recognition-meta"><span><i></i> {recognitionEngine === "cloud" ? "Gemini 音频 · 估算时间" : hardware?.assessment.tier === "recommended" ? "本地模式 · 推荐配置" : "本地模式 · 需要检测"}</span><button onClick={() => setStyleOpen(!styleOpen)}>字幕样式 {styleOpen ? "⌃" : "⌄"}</button></div>
    {styleOpen && <div className="subtitle-style-editor">
      <div className="style-editor-title"><strong>全局字幕样式</strong><span>自动应用到全部字幕</span></div>
      <label>字体<select value={subtitleStyle.fontFamily} onChange={(event) => updateSubtitleStyle("fontFamily", event.target.value)}><option value={'Arial, "PingFang SC", "Microsoft YaHei", sans-serif'}>系统黑体</option><option value={'Georgia, "Songti SC", serif'}>中英衬线</option><option value={'"Arial Black", "PingFang SC", sans-serif'}>醒目粗体</option><option value={'"Courier New", monospace'}>等宽字体</option></select></label>
      <label>字号 <b>{subtitleStyle.fontSize}px</b><input type="range" min="20" max="64" value={subtitleStyle.fontSize} onChange={(event) => updateSubtitleStyle("fontSize", Number(event.target.value))}/></label>
      <div className="style-color-grid"><label>文字颜色<input type="color" value={subtitleStyle.color} onChange={(event) => updateSubtitleStyle("color", event.target.value)}/></label><label>描边颜色<input type="color" value={subtitleStyle.outlineColor} onChange={(event) => updateSubtitleStyle("outlineColor", event.target.value)}/></label></div>
      <label>描边 <b>{subtitleStyle.outlineWidth}px</b><input type="range" min="0" max="6" value={subtitleStyle.outlineWidth} onChange={(event) => updateSubtitleStyle("outlineWidth", Number(event.target.value))}/></label>
      <button className="reset-style" onClick={() => setSubtitleStyle(defaultSubtitleStyle)}>恢复默认样式</button>
    </div>}
    <div className="subtitle-list">
      {project.subtitles.map((item) => <div className={`subtitle-row ${current >= item.start && current < item.end ? "active" : ""}`} key={item.id} onClick={() => seek(item.start + 0.05)}>
        <time>{formatClock(item.start).slice(0, 5)}</time><div>
          {subtitleMode !== "en" && <input disabled={isGenerating} value={item.zh} onChange={(event) => updateSubtitle(item.id, "zh", event.target.value)} />}
          {subtitleMode !== "zh" && <input disabled={isGenerating} className="translation" value={item.en} onChange={(event) => updateSubtitle(item.id, "en", event.target.value)} />}
          <div className="subtitle-timing" onClick={(event) => event.stopPropagation()}>{(["start", "end"] as const).map((field) => <label key={field}>{field === "start" ? "起" : "止"}<input key={item[field]} aria-label={`${field === "start" ? "开始" : "结束"}时间（秒）`} type="number" min="0" max={duration} step="0.01" defaultValue={item[field].toFixed(2)} disabled={isGenerating} onBlur={(event) => { if (!updateSubtitleTime(item.id, field, event.currentTarget.valueAsNumber)) event.currentTarget.value = item[field].toFixed(2); }} /></label>)}</div>
        </div><button title="删除字幕" onClick={(event) => { event.stopPropagation(); setSubtitles(project.subtitles.filter((subtitle) => subtitle.id !== item.id)); }}>×</button>
      </div>)}
      {!project.subtitles.length && <p className="empty-hint">把含人声的视频或音频拖到时间轴，选择识别模型后生成字幕。</p>}
    </div>
  </>;

  const cropClip = cropOpen ? primaryClip : null;
  const cropAsset = cropClip ? assetMap.get(cropClip.assetId) : undefined;

  return <main className="app-shell">
    <input ref={fileInputRef} className="hidden-input" type="file" accept="video/*,image/*,audio/*" multiple onChange={importFiles} />
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><i></i><i></i></span><strong>DashCut <em>极剪</em></strong></div>
      <div className="project-title"><div><strong>城市漫游</strong><span>{formatClock(duration, false)} · {project.clips.length} 个片段</span></div></div>
      <div className="top-actions"><button className="ghost hide-mobile" onClick={() => setAboutOpen(true)}>关于与许可</button><button className="export-button" onClick={() => setExportOpen(true)}>导出视频 <span>↗</span></button></div>
    </header>

    <section className="workspace">
      <aside className="side-panel">
        <nav className="panel-tabs"><button className={leftTab === "media" ? "active" : ""} onClick={() => setLeftTab("media")}><Icon name="film" size={14} />素材</button><button className={leftTab === "subtitles" ? "active" : ""} onClick={() => setLeftTab("subtitles")}><b>字</b>自动字幕</button></nav>
        <div className="panel-scroll">{leftTab === "media" ? mediaPanel : subtitlesPanel}</div>
      </aside>

      <section className="stage">
        <div className="stage-toolbar"><span>{busy || (hoverTime !== null && toggles.previewAxis && !playing ? `预览轴 ${formatClock(hoverTime)}` : "")}</span><div className="segmented ratio-switch"><button className={ratio === "16:9" ? "active" : ""} onClick={() => setRatio("16:9")}>16:9 横屏</button><button className={ratio === "9:16" ? "active" : ""} onClick={() => setRatio("9:16")}>9:16 竖屏</button></div></div>
        <Preview project={project} assets={assetMap} time={previewTime} playing={playing} muted={muted} ratio={ratio} subtitleMode={subtitleMode} subtitleStyle={subtitleStyle} onImport={() => fileInputRef.current?.click()} />
        <div className="player-controls"><span>{formatClock(current)} <i>/ {formatClock(duration)}</i></span><div><button title="回到开头" onClick={() => seek(0)}><Icon name="prev" size={14} /></button><button data-play-toggle className="play" onClick={togglePlay} title="播放 / 暂停（空格）"><Icon name={playing ? "pause" : "play"} size={14} /></button><button title="跳到结尾" onClick={() => seek(duration)}><Icon name="next" size={14} /></button></div><div><button title={muted ? "取消静音" : "静音预览"} onClick={() => setMuted(!muted)}><Icon name={muted ? "mute" : "volume"} size={15} /></button><button title="全屏预览" onClick={() => void document.querySelector(".video-frame")?.requestFullscreen()}><Icon name="fullscreen" size={14} /></button></div></div>
      </section>

      <Inspector clip={primaryClip} asset={primaryAsset} tab={inspectorTab} onTab={setInspectorTab} onChange={changeClip} onCrop={() => runAction("crop")} />
    </section>

    <section className="timeline-area">
      <TimelineToolbar mode={mode} onMode={setMode} canUndo={history.past.length > 0} canRedo={history.future.length > 0} hasSelection={selectedClips.length > 0} selectionIsVideo={primaryAsset?.kind === "video" && primaryClip?.freezeAt === null} recording={recording} toggles={toggles} zoom={zoom} settings={timelineSettings}
        onAction={runAction} onToggle={(key) => setToggles((value) => ({ ...value, [key]: !value[key] }))} onZoom={(value) => setZoom(Math.max(2, Math.min(400, value)))} onSettings={setTimelineSettings} />
      <Timeline project={project} assets={assetMap} time={current} hoverTime={hoverTime} duration={duration} selection={selection} mode={mode} toggles={toggles} zoom={zoom} settings={timelineSettings} coverImage={coverImage || mainThumb} draggingAssetId={draggingAssetId}
        onSeek={seek} onHover={setHoverTime} onSelect={setSelection} onDropAsset={dropAsset} onMoveClip={moveClip} onTrimClip={trimClip} onBlade={bladeSplit}
        onTrack={(trackId, patch) => commit((state) => ({ ...state, tracks: state.tracks.map((track) => track.id === trackId ? { ...track, ...patch } : track) }))}
        onRemoveMarker={(id) => commit((state) => ({ ...state, markers: state.markers.filter((marker) => marker.id !== id) }))}
        onZoom={(value) => setZoom(Math.max(2, Math.min(400, value)))} onCover={() => setCoverOpen(true)} onViewport={setViewportWidth} />
    </section>

    {typeof recording === "number" && <div className="countdown-overlay"><span>{recording}</span><small>即将开始录音</small></div>}

    {cropClip && cropAsset && <CropModal clip={cropClip} asset={cropAsset} onClose={() => setCropOpen(false)} onApply={(crop) => { commit((state) => updateClip(state, cropClip.id, { crop }, options)); setCropOpen(false); }} />}

    {coverOpen && <div className="modal-backdrop" onMouseDown={() => setCoverOpen(false)}><section className="cover-modal" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span className="eyebrow">COVER STUDIO</span><h2>编辑封面</h2></div><button onClick={() => setCoverOpen(false)}>×</button></header>
      <div className="cover-workspace"><div className="canvas-wrap"><canvas ref={canvasRef}></canvas><span>1280 × 720 · 16:9</span></div><aside>
        <label>封面标题<input value={coverTitle} maxLength={24} onChange={(event) => setCoverTitle(event.target.value)} /></label>
        <label>强调色<div className="color-options">{["#ffcc45", "#56e0c7", "#ff7289", "#8ba8ff"].map((color) => <button key={color} className={coverAccent === color ? "active" : ""} style={{ background: color }} onClick={() => setCoverAccent(color)} />)}</div></label>
        <label>背景<div className="platform-preview"><button className={coverBackground ? "" : "active"} onClick={() => setCoverBackground("")}>渐变预设</button><button className={coverBackground ? "active" : ""} onClick={() => void applyCurrentFrameToCover()}>当前画面</button></div></label>
        <button className="primary full" onClick={() => renderCover(true)}>保存封面 PNG</button>
      </aside></div>
    </section></div>}

    {exportOpen && <div className="modal-backdrop export-backdrop" onMouseDown={() => !exporting && setExportOpen(false)}><section className="export-modal" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span className="eyebrow">EXPORT</span><h2>导出视频</h2></div><button onClick={() => !exporting && setExportOpen(false)}>×</button></header>
      {exporting || exportResult ? <div className="export-progress"><div className="progress-ring" style={{ "--progress": `${progress * 3.6}deg` } as React.CSSProperties}><span>{progress}%</span></div><h3>{exportResult ? "导出完成" : "正在渲染视频"}</h3><p>{exportResult ? `已生成 MP4、中文 SRT 和英文 SRT` : `${progressStage} · ${exportFps} FPS`}</p>{exportResult && <div className="export-complete-actions"><button className="primary" onClick={() => window.dashCutDesktop?.revealExport(exportResult.outputPath)}>打开文件位置</button><button className="ghost-action" onClick={() => { setExportResult(null); setProgress(0); }}>继续导出</button></div>}</div> : <div className="export-form">
        <label>发布平台<div className="platform-cards"><button className={platform === "bilibili" ? "active bili" : "bili"} onClick={() => setPlatform("bilibili")}><b>哔</b><span>哔哩哔哩<small>1080P · 高码率</small></span><i>✓</i></button><button className={platform === "youtube" ? "active youtube" : "youtube"} onClick={() => setPlatform("youtube")}><b>▶</b><span>YouTube<small>1080P · H.264</small></span><i>✓</i></button></div></label>
        <div className="export-grid"><label>分辨率<select value={exportResolution} onChange={(event) => setExportResolution(Number(event.target.value) as 720 | 1080 | 2160)}><option value="1080">1080P</option><option value="2160">4K</option><option value="720">720P</option></select></label><label>帧率<div className="segmented"><button className={exportFps === 30 ? "active" : ""} onClick={() => setExportFps(30)}>30 FPS</button><button className={exportFps === 60 ? "active" : ""} onClick={() => setExportFps(60)}>60 FPS</button></div></label></div>
        <div className="export-summary"><span>时长</span><strong>{formatClock(duration)}</strong><i></i><span>画布</span><strong>{ratio} · {project.tracks.filter((track) => track.kind === "video").length} 视频轨</strong></div>
        <button className="primary full large" onClick={() => void startExport()}>开始导出 MP4 · {exportFps} FPS</button>
      </div>}
    </section></div>}

    {hardwareOpen && <div className="modal-backdrop" onMouseDown={() => setHardwareOpen(false)}><section className="hardware-modal" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span className="eyebrow">LOCAL AI CHECK</span><h2>本地字幕硬件检测</h2></div><button onClick={() => setHardwareOpen(false)}>×</button></header>
      {!window.dashCutDesktop ? <div className="hardware-empty"><b>请在 DashCut 极剪桌面版中运行检测</b><p>浏览器无法读取完整的 CPU、GPU、内存和磁盘信息。本地 faster-whisper 只在 Windows / macOS 桌面应用中提供。</p></div> : checkingHardware ? <div className="hardware-empty"><b>正在检查设备…</b><p>检测 CPU、CUDA GPU、系统内存、磁盘和内置 AI 运行时。</p></div> : hardware && <div className="hardware-content">
        <div className={`hardware-verdict ${hardware.assessment.tier}`}><span>{hardware.assessment.tier === "recommended" ? "✓" : hardware.assessment.tier === "minimum" ? "!" : "×"}</span><div><b>{hardware.assessment.tier === "recommended" ? "达到推荐配置" : hardware.assessment.tier === "minimum" ? "达到最低配置" : "暂不适合本地识别"}</b><small>{hardware.assessment.tier === "unsupported" ? "建议使用云端模型" : `建议 ${hardware.assessment.model} · ${hardware.assessment.computeType}`}</small></div></div>
        <div className="hardware-grid"><div><span>CPU</span><b>{hardware.cpu.model}</b><small>{hardware.cpu.logicalCores} 个逻辑核心</small></div><div><span>系统内存</span><b>{hardware.memory.totalGb} GB</b><small>当前可用 {hardware.memory.freeGb} GB</small></div><div><span>图形处理器</span><b>{hardware.gpus[0]?.name || "未检测到独立 GPU"}</b><small>{hardware.gpus[0]?.fasterWhisperAcceleration ? `${hardware.gpus[0].memoryGb ?? "未知"} GB VRAM · CUDA` : "faster-whisper 将使用 CPU"}</small></div><div><span>可用磁盘</span><b>{hardware.diskFreeGb} GB</b><small>建议预留至少 10 GB</small></div></div>
        <div className="runtime-status"><strong>内置运行时</strong><span className={hardware.runtime?.ready ? "ready" : ""}>{hardware.runtime?.ready ? `${hardware.runtime.kind === "bundled" ? "随安装包提供" : "开发环境"} · faster-whisper ${hardware.runtime.info?.fasterWhisper ?? ""}` : "不可用，请重新安装 DashCut 极剪"}</span></div>
        {!!hardware.assessment.blockers.length && <div className="hardware-messages blockers"><b>需要解决</b>{hardware.assessment.blockers.map((item) => <span key={item}>• {item}</span>)}</div>}
        {!!hardware.assessment.notes.length && <div className="hardware-messages"><b>检测说明</b>{hardware.assessment.notes.map((item) => <span key={item}>• {item}</span>)}</div>}
        <div className="requirements-table"><div><b>最低配置</b><span>4 核 CPU</span><span>8 GB RAM</span><span>4 GB 空间</span><small>small · CPU INT8</small></div><div><b>推荐配置</b><span>8 核 CPU</span><span>16 GB RAM</span><span>CUDA 8 GB VRAM</span><small>large-v3 · CUDA FP16</small></div></div>
        <section className="model-manager"><header><div><b>选择推理模型</b><small>默认不下载，仅在你点击后安装</small></div><span>推荐：{hardware.assessment.model}</span></header><div className="model-list">{localModels.map((model) => <button key={model.id} className={`${selectedModel === model.id ? "selected" : ""} ${model.id === hardware.assessment.model ? "recommended" : ""}`} onClick={() => setSelectedModel(model.id)}><span className="model-radio">{selectedModel === model.id ? "●" : "○"}</span><div><b>{model.label} {model.id === hardware.assessment.model && <i>推荐</i>}</b><small>{model.description} · 约 {model.approximateGb} GB</small></div>{model.installed ? <span className="model-installed">已安装</span> : <span className="model-not-installed">未下载</span>}</button>)}</div>
          {localModels.find((model) => model.id === selectedModel)?.installed ? <div className="model-action-row"><span>模型已就绪，可离线使用</span><button onClick={() => void removeLocalModel(selectedModel)}>删除模型</button></div> : <button className="primary full" disabled={Boolean(installingModel) || hardware.assessment.tier === "unsupported" || !hardware.runtime?.ready} onClick={() => void installLocalModel(selectedModel)}>{installingModel === selectedModel ? `正在下载安装 ${selectedModel}…` : `下载安装 ${selectedModel} · 约 ${localModels.find((model) => model.id === selectedModel)?.approximateGb ?? "-"} GB`}</button>}
        </section>
        <div className="hardware-actions"><button className="ghost-action" onClick={() => void checkHardware()}>重新检测</button><button className="primary" disabled={hardware.assessment.tier === "unsupported" || !localModels.find((model) => model.id === selectedModel)?.installed} onClick={() => { setRecognitionEngine("local"); setHardwareOpen(false); setToast(`已选择本地 ${selectedModel} 模型`); }}>使用本地模型</button></div>
      </div>}
    </section></div>}

    {aboutOpen && <div className="modal-backdrop" onMouseDown={() => setAboutOpen(false)}><section className="about-modal" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span className="eyebrow">ABOUT & LICENSES</span><h2>DashCut 极剪</h2></div><button onClick={() => setAboutOpen(false)}>×</button></header>
      <div className="about-content"><p>面向哔哩哔哩与 YouTube 创作者的视频编辑器。</p><div><strong>视频运行时</strong><span>FFmpeg 9.0.1 · LGPLv2.1-or-later</span><small>macOS 使用 VideoToolbox，Windows 使用 MediaFoundation。安装包包含许可证、源码地址和实际构建参数。</small></div><div><strong>应用许可证</strong><span>DashCut · MIT License</span></div><a href="https://github.com/Mikasathebest/DashCut/blob/main/THIRD_PARTY_NOTICES.md" target="_blank" rel="noreferrer">查看第三方声明与对应源码 ↗</a></div>
    </section></div>}

    {toast && <div className="toast"><span>✓</span>{toast}</div>}
  </main>;
}

function CropModal({ clip, asset, onClose, onApply }: { clip: Clip; asset: Asset; onClose: () => void; onApply: (crop: Clip["crop"]) => void }) {
  const [crop, setCrop] = useState(clip.crop);
  const [drag, setDrag] = useState<{ handle: string; x: number; y: number; origin: Clip["crop"] } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const aspect = asset.width / Math.max(1, asset.height);
  const presets: Array<[string, number | null]> = [["自由", null], ["原始", aspect], ["16:9", 16 / 9], ["9:16", 9 / 16], ["1:1", 1], ["4:3", 4 / 3]];
  function applyPreset(target: number | null) {
    if (!target) return setCrop({ x: 0, y: 0, w: 1, h: 1 });
    // Largest centred rect with the target pixel aspect.
    const w = Math.min(1, target / aspect);
    const h = Math.min(1, aspect / target);
    setCrop({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
  }
  useEffect(() => {
    if (!drag) return;
    const move = (event: PointerEvent) => {
      const rect = boxRef.current!.getBoundingClientRect();
      const dx = (event.clientX - drag.x) / rect.width;
      const dy = (event.clientY - drag.y) / rect.height;
      const origin = drag.origin;
      let { x, y, w, h } = origin;
      if (drag.handle === "move") {
        x = Math.max(0, Math.min(1 - w, origin.x + dx));
        y = Math.max(0, Math.min(1 - h, origin.y + dy));
      }
      if (drag.handle.includes("l")) { x = Math.max(0, Math.min(origin.x + origin.w - 0.05, origin.x + dx)); w = origin.w + origin.x - x; }
      if (drag.handle.includes("r")) w = Math.max(0.05, Math.min(1 - origin.x, origin.w + dx));
      if (drag.handle.includes("t")) { y = Math.max(0, Math.min(origin.y + origin.h - 0.05, origin.y + dy)); h = origin.h + origin.y - y; }
      if (drag.handle.includes("b")) h = Math.max(0.05, Math.min(1 - origin.y, origin.h + dy));
      setCrop({ x, y, w, h });
    };
    const up = () => setDrag(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [drag]);
  const begin = (handle: string) => (event: React.PointerEvent) => { event.stopPropagation(); setDrag({ handle, x: event.clientX, y: event.clientY, origin: crop }); };
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="crop-modal" onMouseDown={(event) => event.stopPropagation()}>
    <header><div><span className="eyebrow">CROP</span><h2>裁剪画面</h2></div><button onClick={onClose}>×</button></header>
    <div className="crop-stage"><div ref={boxRef} className="crop-box" style={{ aspectRatio: `${asset.width} / ${asset.height}`, backgroundImage: `url("${asset.thumbnail}")` }}>
      <div className="crop-rect" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }} onPointerDown={begin("move")}>
        {["tl", "tr", "bl", "br", "t", "b", "l", "r"].map((handle) => <i key={handle} className={`crop-handle ${handle}`} onPointerDown={begin(handle)} />)}
      </div>
    </div></div>
    <footer><div className="crop-presets">{presets.map(([label, value]) => <button key={label} onClick={() => applyPreset(value)}>{label}</button>)}</div><div><button className="ghost-action" onClick={() => setCrop({ x: 0, y: 0, w: 1, h: 1 })}>重置</button><button className="primary" onClick={() => onApply(crop)}>应用裁剪</button></div></footer>
  </section></div>;
}
