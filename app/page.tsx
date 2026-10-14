"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./editor/icons";
import { Inspector, InspectorTab } from "./editor/Inspector";
import { buildFilmstrip, buildThumbnail, captureFrame, probeFile } from "./editor/media";
import { buildDocument, EditorState, migrateDocument, ProjectDocument, readDocument } from "./editor/project-file";
import {
  addTrack, Asset, Clip, clipAt, clipDuration, clipEnd, createClip, defaultClipSettings, deleteClips, EditOptions, freezeFrame, hasRoom,
  cutSourceRanges, mainTrack, placeClip, Project, projectDuration, pruneTracks, sourceRangeToTimeline, sourceTimeAt, splitAtSourceTimes, splitClip,
  Subtitle, TimedWord, toComposition, trackClips, Transcript, trimAt, uid, updateClip, createProject,
} from "./editor/model";
import { defaultSubtitleStyle, normalizeSubtitleStyle, retimeSubtitle, shiftSubtitles, SubtitleStyle } from "./editor/captions";
import { CaptionStyleEditor, CaptionTimingBar } from "./editor/CaptionTools";
import { applyAgentEdits, AgentContext, AgentOp, cleanCutCandidates, findSegments, getCaptions, getTranscript, serializeTimeline, buildAliases } from "./editor/agent";
import { AgentMessage, AgentPanel } from "./editor/AgentPanel";
import { agentSkills, agentSystemPrompt, agentToolSpecs, AgentSkill } from "./editor/agent-tools";
import { CleanCutReview } from "./editor/CleanCutReview";
import { Preview } from "./editor/Preview";
import { TranscriptPanel } from "./editor/TranscriptPanel";
import { analyzeCleanCut, CleanCutItem, CleanCutSettings, defaultCleanCutSettings, deriveSentences, silenceItems, timelineTranscript, TranscriptWord, wordsToCuts } from "./editor/transcript";
import { clampZoom, DropTarget, formatClock, Timeline, TimelineMode, TimelineSettings, TimelineToolbar, Toggles, ToolbarAction } from "./editor/Timeline";

type LeftTab = "media" | "transcript" | "subtitles";
type MediaFilter = "all" | "video" | "image" | "audio";
type RecognitionEngine = "cloud" | "local";
type History = { past: Project[]; present: Project; future: Project[]; key: string; at: number; revision: number };

// Endpoint and model are remembered between sessions; the API key never is.
const aiSettingsKey = "dashcut.ai-settings";
function savedAiSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(aiSettingsKey) || "{}");
    return { baseUrl: typeof saved.baseUrl === "string" ? saved.baseUrl : "", model: typeof saved.model === "string" ? saved.model : "" };
  } catch { return { baseUrl: "", model: "" }; }
}
// Vocabulary and clean-cut preferences carry over between projects.
const editingSettingsKey = "dashcut.editing-settings";
function savedEditingSettings(): { hotwords: string; cleanCut: CleanCutSettings } {
  try {
    const saved = JSON.parse(localStorage.getItem(editingSettingsKey) || "{}");
    return {
      hotwords: typeof saved.hotwords === "string" ? saved.hotwords : "",
      cleanCut: { ...defaultCleanCutSettings, ...saved.cleanCut, kinds: { ...defaultCleanCutSettings.kinds, ...saved.cleanCut?.kinds } },
    };
  } catch { return { hotwords: "", cleanCut: defaultCleanCutSettings }; }
}

const kindLabels: Record<Asset["kind"], string> = { video: "视频", image: "图片", gif: "动图", audio: "音频" };
const freezeLength = 3;

function isTyping(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return Boolean(element?.closest("input, textarea, select, [contenteditable=true]"));
}

type Recovery = { id: string; title: string; savedAt: string; projectPath: string };
type RecentProject = { path: string; title: string; openedAt: string; exists: boolean };
const autosaveInterval = 30_000;

function newProjectMeta() {
  return { id: uid("project"), title: "未命名项目", createdAt: new Date().toISOString() };
}

export default function Home() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [projectMeta, setProjectMeta] = useState(newProjectMeta);
  const [projectPath, setProjectPath] = useState("");
  const [savedFingerprint, setSavedFingerprint] = useState<string | null>(null);
  const [recoveries, setRecoveries] = useState<Recovery[]>([]);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [missingAssets, setMissingAssets] = useState<string[]>([]);
  const [history, setHistory] = useState<History>(() => ({ past: [], present: createProject(), future: [], key: "", at: 0, revision: 1 }));
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
  const [aiConfig, setAiConfig] = useState<AiConfig>({ baseUrl: "", apiKey: "", model: "" });
  const [aiModels, setAiModels] = useState<AiModel[]>([]);
  const [loadingAiModels, setLoadingAiModels] = useState(false);
  const [captionProgress, setCaptionProgress] = useState<{ progress: number; stage: string } | null>(null);
  const [selectedSubtitle, setSelectedSubtitle] = useState<number | null>(null);
  const [hotwords, setHotwords] = useState("");
  const [cleanCutSettings, setCleanCutSettings] = useState<CleanCutSettings>(defaultCleanCutSettings);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>([]);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentConfig, setAgentConfig] = useState<AgentProviderConfig | null>(null);
  const [cleanCut, setCleanCut] = useState<{ clipIds?: string[]; scope: string; silences: CleanCutItem[] } | null>(null);
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
  const transcriptBlocks = useMemo(() => timelineTranscript(project), [project]);
  const flaggedWords = useMemo(() => analyzeCleanCut(project, cleanCutSettings), [cleanCutSettings, project]);
  const cleanCutItems = useMemo(() => cleanCut ? [...analyzeCleanCut(project, cleanCutSettings, cleanCut.clipIds), ...cleanCut.silences].sort((a, b) => a.start - b.start) : [], [cleanCut, cleanCutSettings, project]);

  /* ------------------------------------------------------------ history */

  const commit = useCallback((next: Project | ((project: Project) => Project), key = "") => {
    setHistory((state) => {
      const value = typeof next === "function" ? next(state.present) : next;
      if (value === state.present) return state;
      const now = Date.now();
      // Continuous slider drags collapse into one undo step.
      if (key && key === state.key && now - state.at < 1200) return { ...state, present: value, future: [], at: now, revision: state.revision + 1 };
      return { past: [...state.past.slice(-99), state.present], present: value, future: [], key, at: now, revision: state.revision + 1 };
    });
  }, []);

  function undo() {
    setHistory((state) => state.past.length ? { past: state.past.slice(0, -1), present: state.past.at(-1)!, future: [state.present, ...state.future], key: "", at: 0, revision: state.revision + 1 } : state);
  }

  function redo() {
    setHistory((state) => state.future.length ? { past: [...state.past, state.present], present: state.future[0], future: state.future.slice(1), key: "", at: 0, revision: state.revision + 1 } : state);
  }

  /* ------------------------------------------------------------ AI settings and caption progress */

  useEffect(() => {
    const saved = savedAiSettings();
    // Restored after mount so server and client render the same initial markup.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAiConfig((config) => ({ ...config, ...saved }));
  }, []);

  useEffect(() => {
    try { localStorage.setItem(aiSettingsKey, JSON.stringify({ baseUrl: aiConfig.baseUrl, model: aiConfig.model })); }
    catch { /* storage unavailable: settings last for this session only */ }
  }, [aiConfig.baseUrl, aiConfig.model]);

  useEffect(() => window.dashCutDesktop?.onCaptionProgress?.((value) => setCaptionProgress(value)), []);

  useEffect(() => {
    const saved = savedEditingSettings();
    // Restored after mount so server and client render the same initial markup.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHotwords(saved.hotwords);
    setCleanCutSettings(saved.cleanCut);
  }, []);

  useEffect(() => {
    try { localStorage.setItem(editingSettingsKey, JSON.stringify({ hotwords, cleanCut: cleanCutSettings })); }
    catch { /* storage unavailable: settings last for this session only */ }
  }, [cleanCutSettings, hotwords]);

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

  /** Opens the clean-cut review for the selected clips, or for the whole timeline when nothing is selected. */
  async function smartTalk() {
    const targets = (selectedClips.length ? selectedClips : project.clips).filter((clip) => assetMap.get(clip.assetId)?.hasAudio && clip.freezeAt === null && !clip.reverse);
    if (!targets.length) return setToast("没有可精剪的人声片段；倒放或定格片段请先恢复");
    const scope = selectedClips.length ? `所选 ${targets.length} 个片段` : "整个时间轴";
    const transcribed = targets.filter((clip) => project.transcripts?.[clip.assetId]);
    const untranscribed = targets.filter((clip) => !project.transcripts?.[clip.assetId]);
    // Clips without a transcript fall back to FFmpeg silence detection.
    const silences: CleanCutItem[] = [];
    if (untranscribed.length && window.dashCutDesktop) {
      setBusy("正在检测静音…");
      try {
        for (const clip of untranscribed) {
          const asset = assetMap.get(clip.assetId)!;
          const result = await window.dashCutDesktop.detectSpeechSegments(asset.sourcePath, { in: clip.in, out: clip.out });
          silences.push(...silenceItems(clip, result.silences, cleanCutSettings.keepPause));
        }
      } catch (error) {
        setToast(error instanceof Error ? error.message : "静音检测失败");
      } finally {
        setBusy("");
      }
    }
    const note = untranscribed.length ? (transcribed.length ? "；部分片段未识别文稿，只检测静音" : "；未识别文稿，只检测静音（识别文稿后可检测语气词和重复）") : "";
    setCleanCut({ clipIds: selectedClips.length ? targets.map((clip) => clip.id) : undefined, scope: scope + note, silences });
  }

  function applyCleanCut(items: CleanCutItem[]) {
    commit(cutSourceRanges(project, items.map((item) => ({ clipId: item.clipId, start: item.sourceStart, end: item.sourceEnd })), options));
    setCleanCut(null);
    setSelection([]);
    setToast(`已剪掉 ${items.length} 处，共 ${items.reduce((sum, item) => sum + item.end - item.start, 0).toFixed(1)} 秒`);
  }

  function deleteTranscriptWords(words: TranscriptWord[]) {
    if (isGenerating) return setToast("请等待识别完成后再编辑");
    const cuts = wordsToCuts(words);
    commit(cutSourceRanges(project, cuts, options));
    setToast(`已删除 ${words.length} 个词，对应画面和字幕已剪掉`);
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
      case "fit": return setZoom(clampZoom(viewportWidth / Math.max(duration * 1.05, 5)));
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
      // On desktop the application menu owns undo/redo so they are not applied twice.
      if (meta && window.dashCutDesktop && (action === "undo" || action === "redo")) return;
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

  function placeCaptions(sources: Array<{ asset: Asset; id: number }>, results: Array<{ clipId: number; segments: Array<{ start: number; end: number; text: string; zh?: string; en?: string; words?: Array<{ start: number; end: number; word: string; probability?: number }> }> }>, cloud: boolean) {
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
          const inside = caption.words?.filter((word) => (word.start + word.end) / 2 >= range.sourceStart && (word.start + word.end) / 2 < range.sourceEnd) ?? [];
          const text = caption.words?.length ? inside.map((word) => word.word).join("").trim() : caption.text;
          if (!text) continue;
          const isChinese = /[㐀-鿿]/u.test(text);
          const words: TimedWord[] = inside.flatMap((word) => {
            const mapped = sourceRangeToTimeline(clip, word.start, word.end);
            return mapped ? [{ start: mapped.start, end: mapped.end, text: word.word, prob: word.probability ?? 1 }] : [];
          });
          generated.push({ id: 0, start: range.start, end: range.end, zh: isChinese ? text : "", en: isChinese ? "" : text, words });
        }
      }
    }
    return generated.sort((a, b) => a.start - b.start).map((item, index) => ({ ...item, id: index + 1 }));
  }

  /** Keeps each asset's recognised words so the transcript survives edits, reopening and re-captioning. */
  function buildTranscripts(sources: Array<{ asset: Asset; id: number }>, results: Array<{ clipId: number; language?: string; segments: Array<{ start: number; end: number; text: string; words?: Array<{ start: number; end: number; word: string; probability?: number }> }> }>, source: Transcript["source"]) {
    const transcripts: Record<string, Transcript> = {};
    for (const result of results) {
      const asset = sources.find((item) => item.id === result.clipId)?.asset;
      if (!asset) continue;
      const words = result.segments.flatMap((segment) => segment.words?.length
        ? segment.words.map((word) => ({ start: word.start, end: word.end, text: word.word, prob: word.probability ?? 1 }))
        // Cloud results only time whole segments; spread the characters evenly as an estimate.
        : [...segment.text].filter((char) => char.trim()).map((char, index, chars) => ({ start: segment.start + ((segment.end - segment.start) * index) / chars.length, end: segment.start + ((segment.end - segment.start) * (index + 1)) / chars.length, text: char, prob: 0.6 })));
      transcripts[asset.id] = { language: result.language ?? "", source, words, sentences: deriveSentences(words) };
    }
    return transcripts;
  }

  function setSubtitles(subtitles: Subtitle[], key = "") {
    commit((state) => ({ ...state, subtitles }), key);
  }

  /** Runs recognition (and optional translation); resolves with the message shown to the user. */
  async function generateSubtitles(verbatim = false, translate?: boolean): Promise<string> {
    let outcome = "";
    const notify = (message: string) => { outcome = message; notify(message); };
    const withTranslation = translate ?? autoTranslate;
    if (isGenerating) return "正在识别中，请稍候";
    if (recognitionEngine === "cloud" || withTranslation) {
      if (!window.dashCutDesktop) { notify("云端字幕仅支持桌面版"); return outcome; }
      if (!aiConfig.baseUrl.trim() || !aiConfig.apiKey.trim() || !aiConfig.model.trim()) {
        { notify(recognitionEngine === "cloud" ? "请先填写 API Base URL、API Key 并选择模型" : "请先填写 API 设置，或关闭自动翻译以离线识别"); return outcome; }
      }
    }
    const sources = captionSources();
    if (recognitionEngine === "local") {
      if (!window.dashCutDesktop) {
        notify("本地识别仅支持桌面版");
        setHardwareOpen(true);
        return outcome;
      }
      if (!hardware?.runtime?.ready) {
        notify("本地 AI 运行时不可用，请重新安装 DashCut 极剪");
        setHardwareOpen(true);
        void checkHardware();
        return outcome;
      }
      if (!localModels.find((model) => model.id === selectedModel)?.installed) {
        notify(`请先下载安装 ${selectedModel} 模型`);
        setHardwareOpen(true);
        return outcome;
      }
      if (!sources.length) { notify("时间轴中没有含人声的视频或音频"); return outcome; }
      setIsGenerating(true);
      setCaptionProgress({ progress: 0, stage: "正在加载本地模型" });
      try {
        const useCuda = Boolean(hardware.gpus.some((gpu) => gpu.fasterWhisperAcceleration) && Number(hardware.runtime.info?.cudaDeviceCount) > 0);
        const response = await window.dashCutDesktop.transcribeLocal({
          clips: sources.map((source) => ({ id: source.id, path: source.asset.sourcePath })),
          model: selectedModel,
          device: useCuda ? "cuda" : "cpu",
          computeType: hardware.assessment.computeType,
          hotwords,
          verbatim,
        });
        setCaptionProgress({ progress: 1, stage: "识别完成" });
        const generated = placeCaptions(sources, response.results, false);
        const transcripts = buildTranscripts(sources, response.results, "local");
        commit((state) => ({ ...state, subtitles: generated, transcripts: { ...state.transcripts, ...transcripts } }));
        if (withTranslation && generated.length) {
          notify("本地识别完成，正在生成中英译文…");
          setCaptionProgress({ progress: 0, stage: "正在翻译" });
          try {
            setSubtitles(await window.dashCutDesktop.translateSubtitles({ config: aiConfig, subtitles: generated }));
            notify(`双语字幕完成 · ${response.model} + ${aiConfig.model}（保留识别时间戳）`);
          } catch (error) {
            notify(`已保留原语言字幕；翻译失败：${error instanceof Error ? error.message : "请重试"}`);
          }
        } else notify(`本地识别完成 · ${response.model} / ${response.device}`);
      } catch (error) {
        notify(error instanceof Error ? error.message : "本地识别失败");
      } finally {
        setIsGenerating(false);
        setCaptionProgress(null);
      }
      return outcome;
    }
    if (!window.dashCutDesktop) return "仅支持桌面版";
    if (!sources.length) { notify("时间轴中没有含人声的视频或音频"); return outcome; }
    setIsGenerating(true);
    setCaptionProgress({ progress: 0, stage: "正在提取音轨" });
    try {
      const response = await window.dashCutDesktop.transcribeCloud({ config: aiConfig, clips: sources.map((source) => ({ id: source.id, path: source.asset.sourcePath })) });
      const transcripts = buildTranscripts(sources, response.results.map((result) => ({ ...result, segments: result.segments.map((segment) => ({ ...segment, text: segment.zh || segment.text })) })), "cloud");
      const generated = placeCaptions(sources, response.results, true);
      commit((state) => ({ ...state, subtitles: generated, transcripts: { ...state.transcripts, ...transcripts } }));
      notify(response.failedChunks
        ? `云端字幕完成，但有 ${response.failedChunks}/${response.totalChunks} 段识别失败，可重试或改用本地识别`
        : "云端双语字幕完成，时间为模型估算；如整体偏早或偏晚，可用“时间偏移”一键校准");
    } catch (error) {
      notify(error instanceof Error ? error.message : "云端识别失败");
    } finally {
      setIsGenerating(false);
      setCaptionProgress(null);
    }
    return outcome;
  }

  async function refreshAiModels() {
    if (!window.dashCutDesktop) return setToast("模型查询仅支持桌面版");
    setLoadingAiModels(true);
    try {
      const models = await window.dashCutDesktop.listAiModels(aiConfig);
      setAiModels(models);
      setToast(`已查询 ${models.length} 个模型；云端识别需选择支持音频输入的模型`);
    } catch (error) { setToast(error instanceof Error ? error.message : "模型查询失败"); }
    finally { setLoadingAiModels(false); }
  }

  async function translateExistingSubtitles() {
    if (!window.dashCutDesktop || isGenerating || !project.subtitles.length) return;
    if (!aiConfig.baseUrl.trim() || !aiConfig.apiKey.trim() || !aiConfig.model.trim()) return setToast("请先填写 API Base URL、API Key 并选择模型");
    setIsGenerating(true);
    setCaptionProgress({ progress: 0, stage: "正在翻译" });
    try {
      setSubtitles(await window.dashCutDesktop.translateSubtitles({ config: aiConfig, subtitles: project.subtitles }));
      setToast("中英译文已更新，字幕时间保持不变");
    } catch (error) { setToast(error instanceof Error ? error.message : "翻译失败，原字幕已保留"); }
    finally { setIsGenerating(false); setCaptionProgress(null); }
  }

  // Changing a start moves this caption and every later one; extending an end pushes later captions only on overlap.
  function updateSubtitleTime(id: number, field: "start" | "end", value: number) {
    const subtitle = project.subtitles.find((item) => item.id === id);
    if (!subtitle || !Number.isFinite(value) || value < 0 || (field === "end" && value <= subtitle.start)) {
      setToast("字幕时间不能为负，结束时间必须大于开始时间");
      return false;
    }
    setSubtitles(retimeSubtitle(project.subtitles, id, field, value));
    return true;
  }

  function shiftCaptions(delta: number, fromSelected: boolean) {
    if (!project.subtitles.length) return;
    setSubtitles(shiftSubtitles(project.subtitles, delta, fromSelected ? selectedSubtitle : null), "caption-shift");
    setToast(`${fromSelected ? "选中及之后的" : "全部"}字幕已${delta > 0 ? "延后" : "提前"} ${Math.abs(delta)} 秒`);
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
      const request = toComposition(project, assets, { ratio, resolution: exportResolution, fps: exportFps, platform, subtitleStyle, subtitleMode });
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

  /* ------------------------------------------------------------ assistant */

  const planResolvers = useRef(new Map<string, (decision: { approved: boolean; feedback: string }) => void>());
  const planApproved = useRef(false);
  const editRevisions = useRef(new Map<string, number>());
  const agentState = useRef({ history, assets, title: projectMeta.title, ratio, captionStyle: subtitleStyle as unknown as Record<string, unknown>, captionMode: subtitleMode, options, cleanCutSettings, generateSubtitles });
  useEffect(() => {
    agentState.current = { history, assets, title: projectMeta.title, ratio, captionStyle: subtitleStyle as unknown as Record<string, unknown>, captionMode: subtitleMode, options, cleanCutSettings, generateSubtitles };
  });

  // Undo/redo across an assistant edit restores the canvas and caption settings captured with it.
  const view = project.view;
  useEffect(() => {
    if (!view) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRatio(view.ratio);
    setSubtitleStyle(normalizeSubtitleStyle(view.captionStyle as Partial<SubtitleStyle>));
    setSubtitleMode(view.captionMode);
  }, [view]);

  function agentContext(): AgentContext {
    const state = agentState.current;
    return { project: state.history.present, assets: state.assets, revision: state.history.revision, title: state.title, ratio: state.ratio, captionStyle: state.captionStyle, captionMode: state.captionMode, options: state.options };
  }

  const pushAgent = (message: AgentMessage) => setAgentMessages((items) => [...items, message]);

  async function runAgentTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const context = agentContext();
    switch (name) {
      case "get_timeline": return { revision: context.revision, view: serializeTimeline(context) };
      case "get_captions": return getCaptions(context, Number(args.from) || 1, Number(args.to) || undefined);
      case "get_caption_style": return context.captionStyle;
      case "get_transcript": return getTranscript(context, { start: args.start as number | undefined, end: args.end as number | undefined });
      case "find_segments": return findSegments(context, String(args.query ?? ""));
      case "clean_cut_candidates": return cleanCutCandidates(context, Array.isArray(args.clips) ? args.clips as string[] : undefined, agentState.current.cleanCutSettings);
      case "analyze_media": {
        const aliases = buildAliases(context.project, context.assets);
        const asset = context.assets.find((item) => item.id === aliases.assetId.get(String(args.asset)));
        if (!asset) throw new Error(`找不到素材 ${String(args.asset)}`);
        const range = { in: (Number(args.start) || 0) / 1000, out: args.end === undefined ? asset.duration : Number(args.end) / 1000 };
        if (args.analysis === "loudness") {
          if (!asset.peaks.length) return { error: "该素材没有可用的音频波形" };
          const perSecond = Array.from({ length: Math.ceil(range.out - range.in) }, (_, second) => {
            const from = Math.floor((range.in + second) * asset.peaksPerSecond);
            return Number(Math.max(0, ...asset.peaks.slice(from, from + asset.peaksPerSecond)).toFixed(2));
          });
          return { startMs: Math.round(range.in * 1000), peakPerSecond: perSecond.slice(0, 900) };
        }
        if (!window.dashCutDesktop || !asset.sourcePath) throw new Error("素材分析仅支持桌面版的本地文件");
        if (args.analysis === "scenes") return { cutsMs: (await window.dashCutDesktop.detectScenes(asset.sourcePath, range)).map((time) => Math.round(time * 1000)) };
        const { silences } = await window.dashCutDesktop.detectSpeechSegments(asset.sourcePath, range);
        return { silencesMs: silences.map((item) => ({ start: Math.round(item.start * 1000), end: Math.round(item.end * 1000) })) };
      }
      case "propose_plan": {
        const id = uid("plan");
        const steps = Array.isArray(args.steps) ? args.steps.map(String) : [];
        pushAgent({ id, kind: "plan", summary: String(args.summary ?? ""), steps, decision: "pending" });
        const decision = await new Promise<{ approved: boolean; feedback: string }>((resolve) => planResolvers.current.set(id, resolve));
        planApproved.current = decision.approved;
        return decision.approved ? { approved: true } : { approved: false, feedback: decision.feedback || "用户希望调整方案" };
      }
      case "apply_edits": {
        const dryRun = args.dryRun === true;
        if (!dryRun && !planApproved.current) return { ok: false, issues: [{ index: -1, op: "", message: "需要先调用 propose_plan 并获得用户确认" }] };
        const result = applyAgentEdits(context, { baseRevision: Number(args.baseRevision), ops: (Array.isArray(args.ops) ? args.ops : []) as AgentOp[] });
        if (!result.ok) return result;
        if (dryRun) return { ok: true, dryRun: true, changes: result.changes };
        const before = { ratio: context.ratio, captionStyle: context.captionStyle, captionMode: context.captionMode };
        const after = { ratio: result.ratio, captionStyle: result.captionStyle ?? context.captionStyle, captionMode: result.captionMode };
        const revision = context.revision + 1;
        const nextProject = { ...result.project, view: after };
        // One history entry; the previous state records the settings it had so undo restores them too.
        setHistory((state) => ({ past: [...state.past.slice(-99), { ...state.present, view: before }], present: nextProject, future: [], key: "", at: Date.now(), revision: state.revision + 1 }));
        agentState.current = { ...agentState.current, history: { ...agentState.current.history, present: nextProject, revision } };
        const id = uid("edits");
        editRevisions.current.set(id, revision);
        pushAgent({ id, kind: "edits", changes: result.changes, revision, undone: false });
        return { ok: true, revision, changes: result.changes };
      }
      case "generate_captions": {
        if (!planApproved.current) return { error: "需要先调用 propose_plan 并获得用户确认" };
        const message = await agentState.current.generateSubtitles(false, args.translate === true);
        await new Promise((resolve) => window.setTimeout(resolve, 100));
        return { message, captions: agentState.current.history.present.subtitles.length, revision: agentState.current.history.revision };
      }
      default: throw new Error(`未知工具 ${name}`);
    }
  }

  const agentToolRef = useRef(runAgentTool);
  useEffect(() => { agentToolRef.current = runAgentTool; });

  useEffect(() => {
    const desktop = window.dashCutDesktop;
    if (!desktop?.onAgentToolRequest) return;
    const offTool = desktop.onAgentToolRequest(({ requestId, name, args }) => {
      void agentToolRef.current(name, args ?? {})
        .then((result) => desktop.agentToolResponse({ requestId, result }))
        .catch((error) => desktop.agentToolResponse({ requestId, error: error instanceof Error ? error.message : String(error) }));
    });
    const offEvent = desktop.onAgentEvent((event) => {
      if (event.type === "start") return setAgentRunning(true);
      if (event.type === "end") {
        setAgentRunning(false);
        for (const resolve of planResolvers.current.values()) resolve({ approved: false, feedback: "已停止" });
        planResolvers.current.clear();
        return;
      }
      if (event.type === "assistant") return pushAgent({ id: uid("msg"), kind: "assistant", text: event.text });
      if (event.type === "error") return pushAgent({ id: uid("msg"), kind: "error", text: event.message });
      if (event.type === "stopped") return pushAgent({ id: uid("msg"), kind: "status", text: "已停止。已经应用的修改可以用撤销恢复。" });
      if (event.type === "tool-call" && event.name !== "propose_plan" && event.name !== "apply_edits") {
        return pushAgent({ id: `tool-${event.id}`, kind: "tool", name: event.name, status: "running", detail: "" });
      }
      if (event.type === "tool-result") {
        const result = event.result as { error?: string; ok?: boolean; issues?: Array<{ message: string }> } | null;
        if (event.name === "apply_edits" && result?.ok === false) return pushAgent({ id: uid("msg"), kind: "status", text: `修改未通过校验，助手正在调整：${result.issues?.map((issue) => issue.message).slice(0, 2).join("；")}` });
        setAgentMessages((items) => items.map((item) => item.id === `tool-${event.id}` && item.kind === "tool" ? { ...item, status: result?.error ? "failed" : "done", detail: result?.error ?? "" } : item));
      }
    });
    return () => { offTool(); offEvent(); };
  }, []);

  async function openAgent() {
    setAgentOpen(true);
    if (window.dashCutDesktop && !agentConfig) setAgentConfig(await window.dashCutDesktop.agentConfig().catch(() => null));
  }

  function sendToAgent(text: string, skill?: AgentSkill) {
    if (!window.dashCutDesktop) return setToast("极剪助手仅支持桌面版");
    planApproved.current = false;
    pushAgent({ id: uid("msg"), kind: "user", text });
    setAgentRunning(true);
    window.dashCutDesktop.agentSend({ message: text, system: agentSystemPrompt(skill), tools: agentToolSpecs }).catch((error) => {
      setAgentRunning(false);
      pushAgent({ id: uid("msg"), kind: "error", text: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "发送失败" });
    });
  }

  function decidePlan(id: string, approved: boolean, feedback: string) {
    setAgentMessages((items) => items.map((item) => item.id === id && item.kind === "plan" ? { ...item, decision: approved ? "approved" : "rejected", feedback } : item));
    planResolvers.current.get(id)?.({ approved, feedback });
    planResolvers.current.delete(id);
  }

  function undoAgentEdit(id: string) {
    if (editRevisions.current.get(id) !== history.revision) return setToast("这次修改之后还有其他编辑，请用 ⌘Z 逐步撤销");
    undo();
    setAgentMessages((items) => items.map((item) => item.id === id && item.kind === "edits" ? { ...item, undone: true } : item));
  }

  async function resetAgent() {
    await window.dashCutDesktop?.agentReset();
    setAgentMessages([]);
  }

  /* ------------------------------------------------------------ project files */

  function editorState(): EditorState {
    return {
      id: projectMeta.id,
      title: projectMeta.title.trim() || "未命名项目",
      createdAt: projectMeta.createdAt,
      ratio,
      project,
      assets,
      captionStyle: subtitleStyle,
      captionMode: subtitleMode,
      exportSettings: { resolution: exportResolution, fps: exportFps, platform },
      cover: { title: coverTitle, accent: coverAccent },
    };
  }

  // Everything that is written to disk except the save timestamp; changes mark the project dirty.
  const fingerprint = useMemo(() => {
    const doc = buildDocument({ id: projectMeta.id, title: projectMeta.title, createdAt: projectMeta.createdAt, ratio, project, assets, captionStyle: subtitleStyle, captionMode: subtitleMode, exportSettings: { resolution: exportResolution, fps: exportFps, platform }, cover: { title: coverTitle, accent: coverAccent } }, new Date(0));
    return JSON.stringify(doc);
  }, [assets, coverAccent, coverTitle, exportFps, exportResolution, platform, project, projectMeta, ratio, subtitleMode, subtitleStyle]);
  const dirty = savedFingerprint === null ? project.clips.length > 0 || assets.length > 0 : fingerprint !== savedFingerprint;

  useEffect(() => {
    void window.dashCutDesktop?.setProjectState({ dirty, id: projectMeta.id });
  }, [dirty, projectMeta.id]);

  async function autosaveNow() {
    if (!window.dashCutDesktop || !dirty) return;
    await window.dashCutDesktop.autosaveProject({ document: buildDocument(editorState()), projectPath }).catch(() => undefined);
  }

  const autosaveRef = useRef(autosaveNow);
  useEffect(() => { autosaveRef.current = autosaveNow; });
  useEffect(() => {
    const id = window.setInterval(() => void autosaveRef.current(), autosaveInterval);
    return () => window.clearInterval(id);
  }, []);

  async function saveProject(saveAs: boolean) {
    if (!window.dashCutDesktop) return setToast("保存项目仅支持桌面版");
    if (recording !== "idle") return setToast("请先停止录音");
    const unsaved = assets.filter((asset) => !asset.sourcePath && usedAssets.has(asset.id));
    if (unsaved.length) setToast(`${unsaved.length} 个素材没有本地路径，将不会被保存`);
    const state = editorState();
    try {
      const result = await window.dashCutDesktop.saveProject({ document: buildDocument(state), projectPath, saveAs });
      if (result.canceled || !result.projectPath) return false;
      setProjectPath(result.projectPath);
      setSavedFingerprint(fingerprint);
      setToast(`项目已保存 · ${result.projectPath.split("/").pop()}`);
      return true;
    } catch (error) {
      setToast(error instanceof Error ? `保存失败：${error.message}` : "保存失败");
      return false;
    }
  }

  async function refreshRecent() {
    if (window.dashCutDesktop) setRecentProjects(await window.dashCutDesktop.recentProjects());
  }

  function confirmDiscard() {
    return !dirty || window.confirm("当前项目有未保存的修改，继续将丢弃这些修改。确定继续吗？");
  }

  /** Swaps in a whole project: previews are rebuilt in the background and missing media prompts a relink. */
  async function loadEditorState(state: EditorState, path: string, missing: string[], markSaved: boolean) {
    setPlaying(false);
    for (const asset of assets) if (asset.url.startsWith("blob:")) URL.revokeObjectURL(asset.url);
    setAssets(state.assets);
    setHistory((current) => ({ past: [], present: state.project, future: [], key: "", at: 0, revision: current.revision + 1 }));
    setProjectMeta({ id: state.id, title: state.title, createdAt: state.createdAt });
    setProjectPath(path);
    setRatio(state.ratio);
    // Older or newer files may carry fewer or extra style fields; keep defaults for anything missing.
    setSubtitleStyle(normalizeSubtitleStyle(state.captionStyle));
    setSubtitleMode(state.captionMode);
    setExportResolution(state.exportSettings.resolution);
    setExportFps(state.exportSettings.fps);
    setPlatform(state.exportSettings.platform);
    setCoverTitle(state.cover.title || coverTitle);
    setCoverAccent(state.cover.accent || coverAccent);
    setSelection([]);
    seek(0);
    setMissingAssets(missing);
    setSavedFingerprint(markSaved ? JSON.stringify(buildDocument(state, new Date(0))) : "");
    for (const asset of state.assets) if (!missing.includes(asset.id)) void refreshPreviews(asset);
  }

  async function refreshPreviews(asset: Asset) {
    const thumbnail = await buildThumbnail(asset).catch(() => "");
    patchAsset(asset.id, { thumbnail });
    if (asset.kind === "video") void buildFilmstrip(asset).then((frames) => patchAsset(asset.id, { frames }));
    if ((asset.kind === "video" || asset.kind === "audio") && window.dashCutDesktop) void window.dashCutDesktop.extractWaveform(asset.sourcePath).then((wave) => patchAsset(asset.id, { peaks: wave.peaks, peaksPerSecond: wave.peaksPerSecond, hasAudio: wave.peaks.length > 0 })).catch(() => undefined);
  }

  async function documentToState(raw: unknown) {
    const doc: ProjectDocument = migrateDocument(raw);
    const paths = doc.assets.map((asset) => asset.absolutePath).filter(Boolean);
    const urls = await window.dashCutDesktop!.registerMedia(paths);
    const lookup = new Map(paths.map((item, index) => [item, urls[index]]));
    return readDocument(doc, (absolutePath) => lookup.get(absolutePath) ?? "");
  }

  async function openProject(target?: string) {
    if (!window.dashCutDesktop) return setToast("打开项目仅支持桌面版");
    if (!confirmDiscard()) return;
    try {
      const result = await window.dashCutDesktop.openProject(target);
      if (result.canceled || !result.document) return;
      const state = await documentToState(result.document);
      await loadEditorState(state, result.projectPath ?? "", result.missing ?? [], true);
      setToast(result.missing?.length ? `项目已打开，${result.missing.length} 个素材需要重新定位` : `已打开「${state.title}」`);
    } catch (error) {
      setToast(error instanceof Error ? `无法打开项目：${error.message}` : "无法打开项目");
    }
  }

  async function newProject() {
    if (!confirmDiscard()) return;
    if (window.dashCutDesktop) await window.dashCutDesktop.discardRecovery(projectMeta.id);
    const meta = newProjectMeta();
    await loadEditorState({ ...editorState(), ...meta, ratio: "16:9", project: createProject(), assets: [], captionStyle: defaultSubtitleStyle, captionMode: "both" }, "", [], false);
    setSavedFingerprint(null);
  }

  async function restoreRecovery(item: Recovery) {
    if (!window.dashCutDesktop) return;
    try {
      const payload = await window.dashCutDesktop.readRecovery(item.id);
      const state = await documentToState(payload.document);
      await loadEditorState(state, payload.projectPath, payload.missing, false);
      setRecoveries([]);
      setToast(`已恢复「${state.title}」，请保存项目`);
    } catch (error) {
      setToast(error instanceof Error ? `恢复失败：${error.message}` : "恢复失败");
    }
  }

  async function discardRecoveries() {
    for (const item of recoveries) await window.dashCutDesktop?.discardRecovery(item.id);
    setRecoveries([]);
  }

  async function relinkAsset(assetId: string) {
    const asset = assetMap.get(assetId);
    if (!asset || !window.dashCutDesktop) return;
    const others = missingAssets.filter((id) => id !== assetId).map((id) => assetMap.get(id)!).filter(Boolean);
    const result = await window.dashCutDesktop.locateMedia({ name: asset.name, otherNames: others.map((item) => item.name) });
    if (result.canceled || !result.path) return;
    // Files found next to the chosen one under the same names are relinked in the same step.
    const updates = [{ asset, path: result.path }, ...others.filter((item) => result.siblings?.[item.name]).map((item) => ({ asset: item, path: result.siblings![item.name] }))];
    const urls = await window.dashCutDesktop.registerMedia(updates.map((item) => item.path));
    updates.forEach((item, index) => {
      const next = { ...item.asset, sourcePath: item.path, url: urls[index] };
      patchAsset(item.asset.id, { sourcePath: next.sourcePath, url: next.url });
      void refreshPreviews(next);
    });
    setMissingAssets((ids) => ids.filter((id) => !updates.some((item) => item.asset.id === id)));
    setToast(`已重新定位 ${updates.length} 个素材`);
  }

  useEffect(() => {
    if (!window.dashCutDesktop) return;
    void window.dashCutDesktop.recoveryList().then(setRecoveries).catch(() => undefined);
  }, []);

  const commandRef = useRef<(command: string) => void>(() => undefined);
  useEffect(() => {
    commandRef.current = (command: string) => {
      const typing = isTyping(document.activeElement);
      if (command === "undo" || command === "redo") {
        if (typing) return void document.execCommand(command);
        return command === "undo" ? undo() : redo();
      }
      if (command === "new") return void newProject();
      if (command === "open") return void openProject();
      if (command === "save") return void saveProject(false);
      if (command === "save-as") return void saveProject(true);
      if (command === "import") return fileInputRef.current?.click();
      if (command === "export") return setExportOpen(true);
      if (command === "agent") return agentOpen ? setAgentOpen(false) : void openAgent();
      if (command === "autosave") return void autosaveNow();
      if (command === "save-and-close") void saveProject(false).then((saved) => { if (saved) void window.dashCutDesktop?.closeReady(); });
    };
  });
  useEffect(() => window.dashCutDesktop?.onMenuCommand((command) => commandRef.current(command)), []);

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

  const percent = captionProgress ? Math.round(captionProgress.progress * 100) : 0;
  const subtitlesPanel = <>
    <div className="language-switch"><button className={subtitleMode === "zh" ? "active" : ""} onClick={() => setSubtitleMode("zh")}>中文</button><button className={subtitleMode === "en" ? "active" : ""} onClick={() => setSubtitleMode("en")}>English</button><button className={subtitleMode === "both" ? "active" : ""} onClick={() => setSubtitleMode("both")}>中英双语</button></div>
    <div className="engine-switch"><button className={recognitionEngine === "cloud" ? "active" : ""} onClick={() => setRecognitionEngine("cloud")}><b>☁</b><span>云端模型<small>需要网络 · 估算时间</small></span></button><button className={recognitionEngine === "local" ? "active" : ""} onClick={() => { setRecognitionEngine("local"); void checkHardware(); }}><b>⌁</b><span>本地模型<small>离线 · 精确时间</small></span></button></div>
    <details className="ai-settings" open={!aiConfig.baseUrl || !aiConfig.model}>
      <summary>API 设置{aiConfig.model ? ` · ${aiConfig.model}` : ""}</summary>
      <label>API Base URL<input value={aiConfig.baseUrl} placeholder="https://…/v1" disabled={isGenerating || loadingAiModels} onChange={(event) => { setAiModels([]); setAiConfig({ ...aiConfig, baseUrl: event.target.value }); }} /></label>
      <label>API Key<input type="password" autoComplete="off" value={aiConfig.apiKey} disabled={isGenerating || loadingAiModels} onChange={(event) => setAiConfig({ ...aiConfig, apiKey: event.target.value })} placeholder="仅本次会话使用，不保存到磁盘" /></label>
      <label>模型<span className="model-picker"><input list="ai-models" value={aiConfig.model} placeholder="选择或输入模型 ID" disabled={isGenerating} onChange={(event) => setAiConfig({ ...aiConfig, model: event.target.value })} /><button className="ghost-action" disabled={loadingAiModels || isGenerating} onClick={() => void refreshAiModels()}>{loadingAiModels ? "查询中…" : aiModels.length ? `刷新 (${aiModels.length})` : "查询"}</button></span><datalist id="ai-models">{aiModels.map((model) => <option key={model.id} value={model.id} />)}</datalist></label>
      {recognitionEngine === "local" && <label className="ai-checkbox"><input type="checkbox" checked={autoTranslate} disabled={isGenerating} onChange={(event) => setAutoTranslate(event.target.checked)} />识别后自动生成中英译文</label>}
      <small>{recognitionEngine === "cloud" ? "云端识别会上传音轨，需选择支持音频输入的模型。" : autoTranslate ? "本地识别后仅将字幕文本发送到接口翻译。" : "关闭自动翻译时，本地识别完全离线。"}</small>
      <button className="ghost-action" disabled={isGenerating || !project.subtitles.length} onClick={() => void translateExistingSubtitles()}>翻译当前字幕 · 保留时间戳</button>
    </details>
    {recognitionEngine === "local" && <label className="hotwords-field">专有名词<input value={hotwords} disabled={isGenerating} placeholder="人名、品牌、术语，空格分隔" onChange={(event) => setHotwords(event.target.value)} /></label>}
    <button className={`generate-button${isGenerating ? " running" : ""}`} onClick={() => void generateSubtitles()} disabled={isGenerating}>
      <span>{isGenerating ? "◌" : "✦"}</span>
      <strong>{isGenerating ? `正在识别 ${percent}%` : "识别字幕"}</strong>
      <small>{isGenerating ? captionProgress?.stage || "正在准备" : "普通话 / English · 自动断句"}</small>
      {isGenerating && <i className="caption-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${percent}%` }} /></i>}
    </button>
    <div className="recognition-meta"><span><i></i> {recognitionEngine === "cloud" ? "云端识别 · 估算时间" : hardware?.assessment.tier === "recommended" ? "本地模式 · 推荐配置" : "本地模式 · 需要检测"}</span><button onClick={() => setStyleOpen(!styleOpen)}>字幕样式 {styleOpen ? "⌃" : "⌄"}</button></div>
    {styleOpen && <CaptionStyleEditor style={subtitleStyle} onChange={setSubtitleStyle} />}
    {project.subtitles.length > 0 && <CaptionTimingBar disabled={isGenerating} selected={selectedSubtitle !== null && project.subtitles.some((item) => item.id === selectedSubtitle)} onShift={shiftCaptions} />}
    <div className="subtitle-list">
      {project.subtitles.map((item) => <div className={`subtitle-row${current >= item.start && current < item.end ? " active" : ""}${selectedSubtitle === item.id ? " selected" : ""}`} key={item.id} ref={selectedSubtitle === item.id ? (element) => element?.scrollIntoView({ block: "nearest" }) : undefined} onClick={() => { setSelectedSubtitle(item.id); seek(item.start + 0.05); }}>
        <time>{formatClock(item.start).slice(0, 5)}</time><div>
          {subtitleMode !== "en" && <input disabled={isGenerating} value={item.zh} onChange={(event) => updateSubtitle(item.id, "zh", event.target.value)} />}
          {subtitleMode !== "zh" && <input disabled={isGenerating} className="translation" value={item.en} onChange={(event) => updateSubtitle(item.id, "en", event.target.value)} />}
          <div className="subtitle-timing" onClick={(event) => event.stopPropagation()}>{(["start", "end"] as const).map((field) => <label key={field}>{field === "start" ? "起" : "止"}<input key={item[field]} aria-label={`${field === "start" ? "开始" : "结束"}时间（秒）`} type="number" min="0" step="0.1" defaultValue={item[field].toFixed(2)} disabled={isGenerating} onBlur={(event) => { if (!updateSubtitleTime(item.id, field, event.currentTarget.valueAsNumber)) event.currentTarget.value = item[field].toFixed(2); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>)}</div>
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
      <div className="project-title">
        <div className="project-menu">
          <button className="project-menu-button" title="项目菜单" onClick={() => { setProjectMenuOpen(!projectMenuOpen); if (!projectMenuOpen) void refreshRecent(); }}><Icon name="film" size={14} /></button>
          {projectMenuOpen && <div className="project-popover" onMouseLeave={() => setProjectMenuOpen(false)}>
            <button onClick={() => { setProjectMenuOpen(false); void newProject(); }}>新建项目<kbd>⌘N</kbd></button>
            <button onClick={() => { setProjectMenuOpen(false); void openProject(); }}>打开项目…<kbd>⌘O</kbd></button>
            <button onClick={() => { setProjectMenuOpen(false); void saveProject(false); }}>保存<kbd>⌘S</kbd></button>
            <button onClick={() => { setProjectMenuOpen(false); void saveProject(true); }}>另存为…<kbd>⇧⌘S</kbd></button>
            {recentProjects.length > 0 && <><b>最近项目</b>{recentProjects.map((item) => <button key={item.path} className={item.exists ? "" : "missing"} title={item.path} onClick={() => { setProjectMenuOpen(false); if (item.exists) void openProject(item.path); else void window.dashCutDesktop?.removeRecentProject(item.path).then(refreshRecent); }}>{item.title}<small>{item.exists ? item.path.split("/").slice(-2, -1)[0] : "文件已移动，点击移除"}</small></button>)}</>}
          </div>}
        </div>
        <div><input className="project-name" aria-label="项目名称" value={projectMeta.title} onChange={(event) => setProjectMeta((meta) => ({ ...meta, title: event.target.value }))} onBlur={(event) => { if (!event.target.value.trim()) setProjectMeta((meta) => ({ ...meta, title: "未命名项目" })); }} /><span>{dirty ? "未保存" : projectPath ? "已保存" : "未保存到磁盘"} · {formatClock(duration, false)} · {project.clips.length} 个片段</span></div>
      </div>
      <div className="top-actions"><button className="ghost hide-mobile" onClick={() => setAboutOpen(true)}>关于与许可</button><button className={`agent-button${agentOpen ? " active" : ""}`} title="极剪助手（⌘J）" onClick={() => agentOpen ? setAgentOpen(false) : void openAgent()}>✦ 极剪助手</button><button className="export-button" onClick={() => setExportOpen(true)}>导出视频 <span>↗</span></button></div>
    </header>

    <section className="workspace">
      <aside className="side-panel">
        <nav className="panel-tabs"><button className={leftTab === "media" ? "active" : ""} onClick={() => setLeftTab("media")}><Icon name="film" size={14} />素材</button><button className={leftTab === "transcript" ? "active" : ""} onClick={() => setLeftTab("transcript")}><Icon name="talk" size={14} />文稿</button><button className={leftTab === "subtitles" ? "active" : ""} onClick={() => setLeftTab("subtitles")}><b>字</b>自动字幕</button></nav>
        <div className="panel-scroll">{leftTab === "media" ? mediaPanel : leftTab === "transcript" ? <TranscriptPanel blocks={transcriptBlocks} time={current} flagged={flaggedWords} busy={isGenerating} canTranscribe={captionSources().length > 0} onSeek={seek} onDelete={deleteTranscriptWords} onTranscribe={() => void generateSubtitles(true)} onCleanCut={() => void smartTalk()} /> : subtitlesPanel}</div>
      </aside>

      <section className="stage">
        <div className="stage-toolbar"><span>{busy || (hoverTime !== null && toggles.previewAxis && !playing ? `预览轴 ${formatClock(hoverTime)}` : "")}</span><div className="segmented ratio-switch"><button className={ratio === "16:9" ? "active" : ""} onClick={() => setRatio("16:9")}>16:9 横屏</button><button className={ratio === "9:16" ? "active" : ""} onClick={() => setRatio("9:16")}>9:16 竖屏</button></div></div>
        <Preview project={project} assets={assetMap} time={previewTime} playing={playing} muted={muted} ratio={ratio} subtitleMode={subtitleMode} subtitleStyle={subtitleStyle} onImport={() => fileInputRef.current?.click()} />
        <div className="player-controls"><span>{formatClock(current)} <i>/ {formatClock(duration)}</i></span><div><button title="回到开头" onClick={() => seek(0)}><Icon name="prev" size={14} /></button><button data-play-toggle className="play" onClick={togglePlay} title="播放 / 暂停（空格）"><Icon name={playing ? "pause" : "play"} size={14} /></button><button title="跳到结尾" onClick={() => seek(duration)}><Icon name="next" size={14} /></button></div><div><button title={muted ? "取消静音" : "静音预览"} onClick={() => setMuted(!muted)}><Icon name={muted ? "mute" : "volume"} size={15} /></button><button title="全屏预览" onClick={() => void document.querySelector(".video-frame")?.requestFullscreen()}><Icon name="fullscreen" size={14} /></button></div></div>
      </section>

      {agentOpen
        ? <AgentPanel messages={agentMessages} running={agentRunning} config={agentConfig} skills={agentSkills} onSend={sendToAgent} onStop={() => void window.dashCutDesktop?.agentStop()} onReset={() => void resetAgent()} onPlan={decidePlan} onUndo={undoAgentEdit}
            onSaveConfig={async (config) => { if (!window.dashCutDesktop) return; try { setAgentConfig(await window.dashCutDesktop.saveAgentConfig(config)); setToast("助手设置已保存"); } catch (error) { setToast(error instanceof Error ? error.message : "保存失败"); } }} onClose={() => setAgentOpen(false)} />
        : <Inspector clip={primaryClip} asset={primaryAsset} tab={inspectorTab} onTab={setInspectorTab} onChange={changeClip} onCrop={() => runAction("crop")} />}
    </section>

    <section className="timeline-area">
      <TimelineToolbar mode={mode} onMode={setMode} canUndo={history.past.length > 0} canRedo={history.future.length > 0} hasSelection={selectedClips.length > 0} selectionIsVideo={primaryAsset?.kind === "video" && primaryClip?.freezeAt === null} recording={recording} toggles={toggles} zoom={zoom} settings={timelineSettings}
        onAction={runAction} onToggle={(key) => setToggles((value) => ({ ...value, [key]: !value[key] }))} onZoom={(value) => setZoom(clampZoom(value))} onSettings={setTimelineSettings} />
      <Timeline project={project} assets={assetMap} time={current} hoverTime={hoverTime} duration={duration} selection={selection} mode={mode} toggles={toggles} zoom={zoom} settings={timelineSettings} coverImage={coverImage || mainThumb} draggingAssetId={draggingAssetId}
        onSeek={seek} onHover={setHoverTime} onSelect={setSelection} onDropAsset={dropAsset} onMoveClip={moveClip} onTrimClip={trimClip} onBlade={bladeSplit}
        onTrack={(trackId, patch) => commit((state) => ({ ...state, tracks: state.tracks.map((track) => track.id === trackId ? { ...track, ...patch } : track) }))}
        onRemoveMarker={(id) => commit((state) => ({ ...state, markers: state.markers.filter((marker) => marker.id !== id) }))}
        onZoom={(value) => setZoom(clampZoom(value))} onCover={() => setCoverOpen(true)} onViewport={setViewportWidth}
        subtitleMode={subtitleMode} selectedSubtitle={selectedSubtitle}
        onSelectSubtitle={(id) => { setSelectedSubtitle(id); if (id !== null) setLeftTab("subtitles"); }}
        onSubtitleChange={(id, patch) => setSubtitles(project.subtitles.map((item) => item.id === id ? { ...item, ...patch } : item).sort((a, b) => a.start - b.start))} />
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
        <div className="requirements-table"><div><b>最低配置</b><span>4 核 CPU</span><span>8 GB RAM</span><span>4 GB 空间</span><small>small · CPU INT8</small></div><div><b>推荐配置</b><span>8 核 CPU</span><span>16 GB RAM</span><span>8 GB 显存 CUDA GPU</span><small>large-v3 · CUDA FP16</small></div></div>
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

    {recoveries.length > 0 && <div className="modal-backdrop"><section className="about-modal recovery-modal">
      <header><div><span className="eyebrow">RECOVERY</span><h2>发现未保存的项目</h2></div></header>
      <div className="about-content"><p>DashCut 上次没有正常关闭，以下项目有自动保存的修改：</p>
        {recoveries.map((item) => <div key={item.id} className="recovery-row"><div><strong>{item.title}</strong><small>{new Date(item.savedAt).toLocaleString("zh-CN")}{item.projectPath ? ` · ${item.projectPath}` : " · 尚未保存到磁盘"}</small></div><button className="primary" onClick={() => void restoreRecovery(item)}>恢复</button></div>)}
        <button className="ghost-action" onClick={() => void discardRecoveries()}>全部丢弃</button>
      </div>
    </section></div>}

    {missingAssets.length > 0 && <div className="modal-backdrop"><section className="about-modal recovery-modal">
      <header><div><span className="eyebrow">RELINK MEDIA</span><h2>找不到 {missingAssets.length} 个素材</h2></div><button onClick={() => setMissingAssets([])}>×</button></header>
      <div className="about-content"><p>素材可能被移动或重命名。定位其中一个文件后，同一文件夹里同名的其他素材会自动重新链接。</p>
        {missingAssets.map((id) => assetMap.get(id)).filter(Boolean).map((asset) => <div key={asset!.id} className="recovery-row"><div><strong>{asset!.name}</strong><small>{asset!.sourcePath || "无路径"}</small></div><button className="primary" onClick={() => void relinkAsset(asset!.id)}>定位…</button></div>)}
        <button className="ghost-action" onClick={() => setMissingAssets([])}>稍后处理</button>
      </div>
    </section></div>}

    {cleanCut && <CleanCutReview items={cleanCutItems} settings={cleanCutSettings} scope={cleanCut.scope} onSettings={setCleanCutSettings} onSeek={seek} onApply={applyCleanCut} onClose={() => setCleanCut(null)} />}

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
