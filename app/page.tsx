"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./editor/icons";
import { Inspector, InspectorTab } from "./editor/Inspector";
import { buildFilmstrip, buildThumbnail, probeFile } from "./editor/media";
import { defaultTextStyle, rasterizeText, textPresets } from "./editor/text";
import { computeReframe } from "./editor/reframe";
import { analysisIssues, captionIssues, HealthIssue } from "./editor/health";
import { HealthCheck } from "./editor/HealthCheck";
import { Language, languageStorageKey, preferredLanguage, setLanguage, t } from "./i18n";
import { LoudnessMeter } from "./editor/LoudnessMeter";
import { buildDocument, EditorState, migrateDocument, ProjectDocument, readDocument } from "./editor/project-file";
import {
  addTrack, Asset, Clip, clipAt, clipDuration, clipEnd, createClip, defaultClipSettings, deleteClips, EditOptions, freezeFrame, hasRoom,
  cutSourceRanges, mainTrack, placeClip, Project, projectDuration, pruneTracks, sourceRangeToTimeline, sourceTimeAt, splitAtSourceTimes, splitClip,
  Subtitle, TextLayer, TimedWord, toComposition, canvasSize, trackClips, Transcript, trimAt, uid, updateClip, createProject,
} from "./editor/model";
import { bestAudioModel, defaultSubtitleStyle, normalizeSubtitleStyle, shiftSubtitles, SubtitleStyle } from "./editor/captions";
import { CaptionStyleEditor, CaptionTimingBar } from "./editor/CaptionTools";
import { applyAgentEdits, AgentContext, AgentOp, cleanCutCandidates, findSegments, getCaptions, getTranscript, serializeTimeline, buildAliases } from "./editor/agent";
import { AgentMessage, AgentPanel } from "./editor/AgentPanel";
import { agentSkills, agentSystemPrompt, agentToolSpecs, AgentSkill } from "./editor/agent-tools";
import { CleanCutReview } from "./editor/CleanCutReview";
import { Preview } from "./editor/Preview";
import { TranscriptPanel } from "./editor/TranscriptPanel";
import { TranslateModal, TranslateRequest } from "./editor/TranslateModal";
import { CoverEditor, FrameSource } from "./editor/CoverEditor";
import { CoverDesign, emptyCover } from "./editor/cover";
import { analyzeCleanCut, CleanCutItem, CleanCutSettings, defaultCleanCutSettings, deriveSentences, silenceItems, timelineTranscript, TranscriptWord, wordsToCuts } from "./editor/transcript";
import { clampZoom, DropTarget, formatClock, Timeline, TimelineMode, TimelineSettings, TimelineToolbar, Toggles, ToolbarAction } from "./editor/Timeline";

type LeftTab = "media" | "text" | "transcript" | "subtitles";
type MediaFilter = "all" | "video" | "image" | "audio";
type RecognitionEngine = "cloud" | "local";
type History = { past: Project[]; present: Project; future: Project[]; key: string; at: number; revision: number };

// Endpoint and model are remembered in localStorage; the API key is kept encrypted by the main process.
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

const kindLabels: Record<Asset["kind"], string> = { video: "视频", image: "图片", gif: "动图", audio: "音频", text: "文本" };
const freezeLength = 3;
type ExportPreset = { id: string; label: string; note: string; format: CompositionOutput["format"]; codec: CompositionOutput["codec"]; loudness: number | null; resolution?: 720 | 1080 | 2160; fps?: 30 | 60; ratio?: "16:9" | "9:16"; platform?: "bilibili" | "youtube" };
const exportPresets: ExportPreset[] = [
  { id: "bilibili", label: "B 站横屏", note: "16:9 · 1080p60 · H.264", format: "mp4", codec: "h264", loudness: -14, resolution: 1080, fps: 60, ratio: "16:9", platform: "bilibili" },
  { id: "youtube-4k", label: "YouTube 4K", note: "16:9 · 2160p · HEVC", format: "mp4", codec: "hevc", loudness: -14, resolution: 2160, fps: 30, ratio: "16:9", platform: "youtube" },
  { id: "vertical", label: "Shorts / 抖音竖屏", note: "9:16 · 1080p · H.264", format: "mp4", codec: "h264", loudness: -14, resolution: 1080, fps: 30, ratio: "9:16", platform: "youtube" },
  { id: "audio", label: "仅音频", note: "M4A · AAC 256k", format: "m4a", codec: "h264", loudness: -16 },
  { id: "gif", label: "GIF 动图", note: "12 fps · 最长 15 秒", format: "gif", codec: "h264", loudness: null },
];
const formatLabels: Record<CompositionOutput["format"], string> = { mp4: "MP4", mov: "MOV", m4a: "M4A 音频", wav: "WAV 音频", gif: "GIF 动图" };

function isTyping(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return Boolean(element?.closest?.("input, textarea, select, [contenteditable=true]"));
}

type Recovery = { id: string; title: string; savedAt: string; projectPath: string };
type RecentProject = { path: string; title: string; openedAt: string; exists: boolean };
const autosaveInterval = 30_000;

function newProjectMeta() {
  return { id: uid("project"), title: t("未命名项目"), createdAt: new Date().toISOString() };
}

export default function Home() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [language, setLanguageState] = useState<Language>("zh");
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
  // Playback speed of the clock: J/K/L shuttle between -4× and 4×.
  const [shuttle, setShuttle] = useState(1);
  const clipboard = useRef<Clip[]>([]);
  // Library clipboard and which area (library or timeline) keyboard shortcuts act on.
  const assetClipboard = useRef<{ assets: Asset[]; cut: boolean }>({ assets: [], cut: false });
  const lastClipboard = useRef<"clips" | "assets">("clips");
  const focusZone = useRef<"library" | "timeline" | "captions">("timeline");
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);
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
  const [aboutOpen, setAboutOpen] = useState(false);
  const [cover, setCover] = useState<CoverDesign>(emptyCover);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFps, setExportFps] = useState<30 | 60>(60);
  const [exportResolution, setExportResolution] = useState<720 | 1080 | 2160>(1080);
  const [platform, setPlatform] = useState<"bilibili" | "youtube">("bilibili");
  const [exportFormat, setExportFormat] = useState<CompositionOutput["format"]>("mp4");
  const [exportCodec, setExportCodec] = useState<CompositionOutput["codec"]>("h264");
  const [loudnessTarget, setLoudnessTarget] = useState<number | null>(-14);
  const [healthOpen, setHealthOpen] = useState(false);
  const [health, setHealth] = useState<{ running: boolean; issues: HealthIssue[] | null }>({ running: false, issues: null });
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
  const [aiKeyLoaded, setAiKeyLoaded] = useState(false);
  const [showAiKey, setShowAiKey] = useState(false);
  const [captionProgress, setCaptionProgress] = useState<{ progress: number; stage: string } | null>(null);
  const [selectedSubtitles, setSelectedSubtitles] = useState<number[]>([]);
  const selectedSubtitle = selectedSubtitles.length ? selectedSubtitles[selectedSubtitles.length - 1] : null;
  const setSelectedSubtitle = (id: number | null) => setSelectedSubtitles(id === null ? [] : [id]);
  const [separationReady, setSeparationReady] = useState<{ runtime: boolean; model: boolean }>({ runtime: false, model: false });
  const [separating, setSeparating] = useState<string | null>(null);
  const [stemUrls, setStemUrls] = useState<Map<string, string>>(() => new Map());
  const [translateOpen, setTranslateOpen] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [hotwords, setHotwords] = useState("");
  const [cleanCutSettings, setCleanCutSettings] = useState<CleanCutSettings>(defaultCleanCutSettings);
  const [agentOpen, setAgentOpen] = useState(false);
  const [reframeOpen, setReframeOpen] = useState(false);
  const [reframeOptions, setReframeOptions] = useState({ tracking: 0.4, switchCanvas: true, scope: "main" as "main" | "selected" });
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>([]);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentConfig, setAgentConfig] = useState<AgentProviderConfig | null>(null);
  const [cleanCut, setCleanCut] = useState<{ clipIds?: string[]; scope: string; silences: CleanCutItem[] } | null>(null);
  const [autoTranslate, setAutoTranslate] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const currentRef = useRef(0);
  const recorderRef = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; start: number } | null>(null);

  const assetMap = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const duration = projectDuration(project);
  const options: EditOptions = useMemo(() => ({ magnet: toggles.magnet, linkage: toggles.linkage }), [toggles.magnet, toggles.linkage]);
  const selectedClips = project.clips.filter((clip) => selection.includes(clip.id));
  const primaryClip = selectedClips.at(-1) ?? null;
  const primaryAsset = primaryClip ? assetMap.get(primaryClip.assetId) ?? null : null;
  // Transitions live on the outgoing main-track clip when the next clip starts right where it ends.
  const transitionAllowed = Boolean(primaryClip && mainTrack(project).id === primaryClip.trackId && project.clips.some((clip) => clip.trackId === primaryClip.trackId && Math.abs(clip.start - clipEnd(primaryClip)) < 0.01));
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

  /* ------------------------------------------------------------ language */

  function switchLanguage(next: Language) {
    setLanguage(next);
    try { localStorage.setItem(languageStorageKey, next); } catch { /* storage unavailable */ }
    setLanguageState(next);
    void window.dashCutDesktop?.setUiLanguage?.(next);
  }

  useEffect(() => {
    const preferred = preferredLanguage();
    setLanguage(preferred);
    // Applied after mount so the server-rendered (Chinese) markup hydrates first.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLanguageState(preferred);
    void window.dashCutDesktop?.setUiLanguage?.(preferred);
  }, []);

  /* ------------------------------------------------------------ AI settings and caption progress */

  useEffect(() => {
    const saved = savedAiSettings();
    // Restored after mount so server and client render the same initial markup.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAiConfig((config) => ({ ...config, ...saved }));
    void window.dashCutDesktop?.savedAiKey?.().then((apiKey) => {
      if (apiKey) setAiConfig((config) => ({ ...config, apiKey }));
      setAiKeyLoaded(true);
    }).catch(() => setAiKeyLoaded(true));
  }, []);

  useEffect(() => {
    if (!aiKeyLoaded) return;
    const timer = window.setTimeout(() => void window.dashCutDesktop?.saveAiKey?.(aiConfig.apiKey).catch(() => undefined), 500);
    return () => window.clearTimeout(timer);
  }, [aiConfig.apiKey, aiKeyLoaded]);

  // With a remembered endpoint and key but no model yet, look the models up once and pick the best.
  const autoModelTried = useRef(false);
  useEffect(() => {
    if (!aiKeyLoaded || autoModelTried.current || aiConfig.model || !aiConfig.baseUrl.trim() || !aiConfig.apiKey.trim()) return;
    autoModelTried.current = true;
    void refreshAiModels();
  });

  useEffect(() => {
    try { localStorage.setItem(aiSettingsKey, JSON.stringify({ baseUrl: aiConfig.baseUrl, model: aiConfig.model })); }
    catch { /* storage unavailable: settings last for this session only */ }
  }, [aiConfig.baseUrl, aiConfig.model]);

  useEffect(() => window.dashCutDesktop?.onCaptionProgress?.((value) => setCaptionProgress(value)), []);
  useEffect(() => {
    void window.dashCutDesktop?.separationStatus?.().then((status) => setSeparationReady({ runtime: status.runtime.ready, model: status.model.installed })).catch(() => undefined);
  }, []);
  // Stem files live outside the project's media; allow them through the media protocol as they appear.
  useEffect(() => {
    const paths = Object.values(project.stems ?? {}).flatMap((stems) => [stems.voice, stems.background]).filter((item) => !stemUrls.has(item));
    if (!paths.length || !window.dashCutDesktop) return;
    void window.dashCutDesktop.registerMedia(paths).then((urls) => setStemUrls((map) => new Map([...map, ...paths.map((item, index) => [item, urls[index]] as [string, string])])));
  }, [project.stems, stemUrls]);

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
      const next = currentRef.current + ((now - last) / 1000) * shuttle;
      last = now;
      if (next <= 0 && shuttle < 0) {
        currentRef.current = 0;
        setCurrent(0);
        setPlaying(false);
        return;
      }
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
  }, [duration, playing, shuttle]);

  function seek(time: number) {
    const next = Math.max(0, Math.min(Math.max(duration, 0), time));
    currentRef.current = next;
    setCurrent(next);
  }

  function togglePlay() {
    if (!project.clips.length) return;
    if (!playing && current >= duration - 0.02) seek(0);
    setShuttle(1);
    setPlaying(!playing);
  }

  /** J/K/L shuttle: repeated J or L doubles the speed in that direction, K stops. */
  function shuttleTo(direction: -1 | 0 | 1) {
    if (!project.clips.length) return;
    if (direction === 0) {
      setPlaying(false);
      setShuttle(1);
      return;
    }
    const next = playing && Math.sign(shuttle) === direction ? Math.max(-4, Math.min(4, shuttle * 2)) : direction;
    if (direction > 0 && current >= duration - 0.02) seek(0);
    setShuttle(next);
    setPlaying(true);
  }

  function stepFrames(frames: number) {
    setPlaying(false);
    // Snap to the frame grid so repeated steps land exactly on frames.
    seek(Math.round(currentRef.current * exportFps + frames) / exportFps);
  }

  /* ------------------------------------------------------------ clipboard */

  function copySelection(remove: boolean) {
    if (!selectedClips.length) return false;
    clipboard.current = selectedClips.map((clip) => ({ ...clip }));
    if (remove) {
      commit(pruneTracks(deleteClips(project, selection, options)));
      setSelection([]);
    }
    setToast(remove ? t("已剪切 {count} 个片段", { count: selectedClips.length }) : t("已复制 {count} 个片段", { count: selectedClips.length }));
    return true;
  }

  /** Pastes at the playhead, keeping relative timing; clips go back to their track when it has room. */
  function pasteClips(at = current) {
    const copied = clipboard.current.filter((clip) => assetMap.has(clip.assetId));
    if (!copied.length) return setToast(t("剪贴板里没有片段"));
    const base = Math.min(...copied.map((clip) => clip.start));
    let next = project;
    const ids: string[] = [];
    for (const clip of [...copied].sort((a, b) => a.start - b.start)) {
      const start = at + clip.start - base;
      const length = clipDuration(clip);
      const asset = assetMap.get(clip.assetId)!;
      const kind = asset.kind === "audio" ? "audio" : "video";
      const original = next.tracks.find((track) => track.id === clip.trackId && !track.locked);
      const resolved = original && (original.main || hasRoom(next, original.id, start, length)) ? { project: next, trackId: original.id } : resolveTrack(next, "new-top", kind, start, length);
      const copy = { ...clip, id: uid("clip"), trackId: resolved.trackId, start };
      next = placeClip(resolved.project, copy, resolved.trackId, start, options);
      ids.push(copy.id);
    }
    commit(next);
    setSelection(ids);
    setToast(t("已粘贴 {count} 个片段", { count: ids.length }));
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
    if (!imported.length) return setToast(t("无法读取所选素材"));
    setAssets((items) => [...items, ...imported]);
    setToast(skipped ? t("已导入 {count} 个素材，{skipped} 个文件无法读取，拖到时间轴开始剪辑", { count: imported.length, skipped }) : t("已导入 {count} 个素材，拖到时间轴开始剪辑", { count: imported.length }));
    for (const asset of imported) {
      if (asset.kind === "video") void buildFilmstrip(asset).then((frames) => patchAsset(asset.id, { frames }));
      if ((asset.kind === "video" || asset.kind === "audio") && window.dashCutDesktop && asset.sourcePath) {
        void window.dashCutDesktop.extractWaveform(asset.sourcePath).then((wave) => patchAsset(asset.id, { peaks: wave.peaks, peaksPerSecond: wave.peaksPerSecond, hasAudio: wave.peaks.length > 0 })).catch(() => undefined);
      }
    }
  }

  /** Select all / copy / cut / paste inside the media library. Paste duplicates entries; cut removes unused ones. */
  function libraryCommand(command: "copy" | "cut" | "paste" | "duplicate" | "select-all") {
    const visible = filteredAssets.map((asset) => asset.id);
    if (command === "select-all") return setSelectedAssets(visible);
    const chosen = assets.filter((asset) => selectedAssets.includes(asset.id));
    if (command === "copy" || command === "cut" || command === "duplicate") {
      if (!chosen.length) return setToast(t("请先在素材库中选择素材"));
      assetClipboard.current = { assets: chosen, cut: command === "cut" };
      lastClipboard.current = "assets";
      if (command === "cut") {
        const removable = chosen.filter((asset) => !usedAssets.has(asset.id));
        // Cut entries stay alive (URLs are not revoked) so a later paste can restore them.
        setAssets((items) => items.filter((item) => !removable.some((asset) => asset.id === item.id)));
        setSelectedAssets([]);
        setToast(removable.length < chosen.length ? t("已剪切 {count} 个素材；正在时间轴中使用的素材保留在素材库", { count: removable.length }) : t("已剪切 {count} 个素材", { count: removable.length }));
        return;
      }
      if (command === "copy") return setToast(t("已复制 {count} 个素材；在素材库粘贴会复制一份，在时间轴粘贴会放到播放头处", { count: chosen.length }));
    }
    const copied = assetClipboard.current.assets;
    if (!copied.length) return setToast(t("剪贴板里没有素材"));
    const restoring = assetClipboard.current.cut;
    // Pasting a cut restores the same entries; pasting a copy adds duplicates that share the media file.
    // Entries a cut left in place (still used on the timeline) are not duplicated.
    const pasted = restoring ? copied.filter((asset) => !assets.some((item) => item.id === asset.id)) : copied.map((asset) => ({ ...asset, id: uid("asset") }));
    if (!pasted.length) return setToast(t("剪贴板里没有素材"));
    setAssets((items) => [...items, ...pasted.filter((asset) => !items.some((item) => item.id === asset.id))]);
    setSelectedAssets(pasted.map((asset) => asset.id));
    if (restoring) assetClipboard.current = { assets: pasted, cut: false };
    setToast(t("已粘贴 {count} 个素材", { count: pasted.length }));
  }

  /** Places library assets at the playhead in order: visuals on the main track, audio on an audio track. */
  function pasteAssetsToTimeline() {
    const copied = assetClipboard.current.assets.filter((asset) => asset.kind !== "text");
    if (!copied.length) return setToast(t("剪贴板里没有素材"));
    if (assetClipboard.current.cut) setAssets((items) => [...items, ...copied.filter((asset) => !items.some((item) => item.id === asset.id))]);
    let next = project;
    let cursor = current;
    const ids: string[] = [];
    for (const asset of copied) {
      const kind = asset.kind === "audio" ? "audio" : "video";
      const resolved = kind === "video" ? { project: next, trackId: mainTrack(next).id } : resolveTrack(next, next.tracks.find((track) => track.kind === "audio" && hasRoom(next, track.id, cursor, asset.duration))?.id ?? "new-bottom", "audio", cursor, asset.duration);
      const clip = createClip(asset, resolved.trackId, cursor);
      next = placeClip(resolved.project, clip, resolved.trackId, cursor + 0.001, options);
      const placed = next.clips.find((item) => item.id === clip.id);
      cursor = placed ? clipEnd(placed) : cursor + asset.duration;
      ids.push(clip.id);
    }
    assetClipboard.current = { ...assetClipboard.current, cut: false };
    commit(pruneTracks(next));
    setSelection(ids);
    setToast(t("已把 {count} 个素材放到时间轴", { count: ids.length }));
  }

  function addText(style: Partial<typeof defaultTextStyle>) {
    const asset: Asset = { id: uid("asset"), name: "文本", kind: "text", url: "", sourcePath: "", duration: 3600, width: 0, height: 0, hasAudio: false, thumbnail: "", frames: [], peaks: [], peaksPerSecond: 0 };
    const length = 3;
    // Titles go on the first free overlay track so they sit above the video.
    const free = project.tracks.find((track) => track.kind === "video" && !track.main && !track.locked && hasRoom(project, track.id, current, length));
    const resolved = free ? { project, trackId: free.id } : resolveTrack(project, "new-top", "video", current, length);
    const clip: Clip = { ...createClip(asset, resolved.trackId, current), out: length, text: { ...defaultTextStyle, ...style } };
    setAssets((items) => [...items, asset]);
    commit(placeClip(resolved.project, clip, resolved.trackId, current, options));
    setSelection([clip.id]);
    setInspectorTab("text");
    setAgentOpen(false);
  }

  function removeAsset(asset: Asset) {
    if (usedAssets.has(asset.id)) return setToast(t("素材正在时间轴中使用，请先删除对应片段"));
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
    if (!(track?.main && toggles.magnet) && !hasRoom(project, clip.trackId, next.start, clipDuration(next), clip.id)) return setToast(t("与同轨道的片段重叠，请先移动相邻片段"));
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
    if (!targets.length) return setToast(t("请把播放头移到要分割的片段上"));
    let next = project;
    let lastRight: string | null = null;
    for (const clip of targets) {
      const result = splitClip(next, clip.id, current);
      next = result.project;
      lastRight = result.rightId ?? lastRight;
    }
    if (next === project) return setToast(t("播放头离片段边缘太近"));
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
    if (!selectedClips.length) return setToast(t("请先在时间轴上选择片段"));
    commit(selectedClips.reduce((value, clip) => updateClip(value, clip.id, patch(clip), options), project), key);
  }

  /** Opens the clean-cut review for the selected clips, or for the whole timeline when nothing is selected. */
  async function smartTalk() {
    const targets = (selectedClips.length ? selectedClips : project.clips).filter((clip) => assetMap.get(clip.assetId)?.hasAudio && clip.freezeAt === null && !clip.reverse);
    if (!targets.length) return setToast(t("没有可精剪的人声片段；倒放或定格片段请先恢复"));
    const scope = selectedClips.length ? t("所选 {count} 个片段", { count: targets.length }) : t("整个时间轴");
    const transcribed = targets.filter((clip) => project.transcripts?.[clip.assetId]);
    const untranscribed = targets.filter((clip) => !project.transcripts?.[clip.assetId]);
    // Clips without a transcript fall back to FFmpeg silence detection.
    const silences: CleanCutItem[] = [];
    if (untranscribed.length && window.dashCutDesktop) {
      setBusy(t("正在检测静音…"));
      try {
        for (const clip of untranscribed) {
          const asset = assetMap.get(clip.assetId)!;
          const result = await window.dashCutDesktop.detectSpeechSegments(asset.sourcePath, { in: clip.in, out: clip.out });
          silences.push(...silenceItems(clip, result.silences, cleanCutSettings.keepPause));
        }
      } catch (error) {
        setToast(error instanceof Error ? error.message : t("静音检测失败"));
      } finally {
        setBusy("");
      }
    }
    const note = untranscribed.length ? (transcribed.length ? t("；部分片段未识别文稿，只检测静音") : t("；未识别文稿，只检测静音（识别文稿后可检测语气词和重复）")) : "";
    setCleanCut({ clipIds: selectedClips.length ? targets.map((clip) => clip.id) : undefined, scope: scope + note, silences });
  }

  function applyCleanCut(items: CleanCutItem[]) {
    commit(cutSourceRanges(project, items.map((item) => ({ clipId: item.clipId, start: item.sourceStart, end: item.sourceEnd })), options));
    setCleanCut(null);
    setSelection([]);
    setToast(t("已剪掉 {count} 处，共 {seconds} 秒", { count: items.length, seconds: items.reduce((sum, item) => sum + item.end - item.start, 0).toFixed(1) }));
  }

  function deleteTranscriptWords(words: TranscriptWord[]) {
    if (isGenerating) return setToast(t("请等待识别完成后再编辑"));
    const cuts = wordsToCuts(words);
    commit(cutSourceRanges(project, cuts, options));
    setToast(t("已删除 {count} 个词，对应画面和字幕已剪掉", { count: words.length }));
  }

  async function smartScenes() {
    const clip = primaryClip;
    const asset = primaryAsset;
    if (!clip || asset?.kind !== "video" || clip.freezeAt !== null) return setToast(t("请先选择一个视频片段"));
    if (!window.dashCutDesktop) return setToast(t("智能镜头分割仅支持桌面版"));
    setBusy(t("正在识别镜头切换…"));
    try {
      const cuts = await window.dashCutDesktop.detectScenes(asset.sourcePath, { in: clip.in, out: clip.out });
      if (!cuts.length) return setToast(t("没有检测到镜头切换"));
      commit((state) => splitAtSourceTimes(state, clip.id, cuts));
      setToast(t("已按镜头切换分割为 {count} 段", { count: cuts.length + 1 }));
    } catch (error) {
      setToast(error instanceof Error ? error.message : t("镜头分割失败"));
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
    if (!navigator.mediaDevices?.getUserMedia) return setToast(t("当前环境不支持录音"));
    if (window.dashCutDesktop && !(await window.dashCutDesktop.requestMicrophone())) return setToast(t("请在系统设置 → 隐私与安全性 → 麦克风中允许 DashCut"));
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      return setToast(t("无法打开麦克风"));
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
    if (blob.size < 1000) return setToast(t("录音太短"));
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
    setToast(t("录音已添加到音频轨"));
  }

  function runAction(action: ToolbarAction) {
    if (isGenerating && !["import", "fit", "record"].includes(action)) return setToast(t("请等待字幕生成完成后再编辑时间线"));
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
        if (!targets.length) return setToast(t("请选择片段并把播放头移到片段内"));
        commit(targets.reduce((value, clip) => trimAt(value, clip.id, current, action === "trim-left" ? "left" : "right", options), project));
        if (action === "trim-left" && toggles.magnet && project.tracks.find((track) => track.id === targets[0].trackId)?.main) seek(targets[0].start);
        return;
      }
      case "delete":
        if (!selectedClips.length && selectedSubtitles.length) {
          const removed = new Set(selectedSubtitles);
          setSubtitles(project.subtitles.filter((item) => !removed.has(item.id)));
          if (removed.size > 1) setToast(t("已删除 {count} 条字幕", { count: removed.size }));
          return setSelectedSubtitle(null);
        }
        if (!selectedClips.length) return;
        commit(pruneTracks(deleteClips(project, selection, options)));
        return setSelection([]);
      case "marker": {
        const existing = project.markers.find((marker) => Math.abs(marker.time - current) < 0.05);
        return commit({ ...project, markers: existing ? project.markers.filter((marker) => marker.id !== existing.id) : [...project.markers, { id: uid("marker"), time: current }] });
      }
      case "freeze": {
        const clip = primaryClip;
        if (!clip || primaryAsset?.kind !== "video" || clip.freezeAt !== null) return setToast(t("请选择一个视频片段"));
        if (current < clip.start || current > clipEnd(clip)) return setToast(t("请把播放头移到所选视频片段上"));
        const result = freezeFrame(project, clip.id, current, freezeLength, options);
        commit(result.project);
        if (result.freezeId) setSelection([result.freezeId]);
        return setToast(t("已在 {time} 定格 {seconds} 秒", { time: formatClock(current), seconds: freezeLength }));
      }
      case "reverse": return patchSelected((clip) => ({ reverse: !clip.reverse }));
      case "mirror": return patchSelected((clip) => ({ mirror: !clip.mirror }));
      case "rotate": return patchSelected((clip) => ({ rotate90: ((clip.rotate90 + 90) % 360) as Clip["rotate90"] }));
      case "crop":
        if (!primaryClip || primaryAsset?.kind === "audio") return setToast(t("请选择一个画面片段"));
        return setCropOpen(true);
      case "smart-extend": return setToast(t("智能延长需要生成式视频模型，即将推出"));
      case "smart-rough": return setToast(t("智能粗剪即将推出"));
      case "smart-talk": return void smartTalk();
      case "smart-scenes": return void smartScenes();
      case "record": return void toggleRecording();
      case "add-video-track":
      case "add-audio-track": {
        const kind = action === "add-video-track" ? "video" : "audio";
        const created = addTrack(project, kind, kind === "video" ? "top" : "bottom");
        commit({ ...created.project, tracks: created.project.tracks.map((track) => track.id === created.trackId ? { ...track, keep: true } : track) });
        return setToast(kind === "video" ? t("已新建视频轨，可把素材拖进去叠加") : t("已新建音频轨"));
      }
      case "fit": return setZoom(clampZoom(viewportWidth / Math.max(duration * 1.05, 5)));
    }
  }

  const actionRef = useRef(runAction);
  useEffect(() => { actionRef.current = runAction; });
  const clipboardCommand = (command: "copy" | "cut" | "paste" | "duplicate" | "select-all") => {
    if (focusZone.current === "library") return libraryCommand(command);
    // After clicking a caption lane (or with no clips at all), select-all picks every caption so they can be deleted together.
    if (command === "select-all" && (focusZone.current === "captions" || (!project.clips.length && project.subtitles.length))) {
      setSelection([]);
      setSelectedSubtitles(project.subtitles.map((item) => item.id));
      return setToast(project.subtitles.length ? t("已选中全部 {count} 条字幕，按 ⌫ 删除", { count: project.subtitles.length }) : t("还没有字幕"));
    }
    if (command === "select-all") return setSelection(project.clips.filter((clip) => !project.tracks.find((track) => track.id === clip.trackId)?.locked).map((clip) => clip.id));
    if (command === "copy" || command === "cut") {
      if (copySelection(command === "cut")) lastClipboard.current = "clips";
      return;
    }
    if (command === "paste") return lastClipboard.current === "assets" ? pasteAssetsToTimeline() : pasteClips();
    if (copySelection(false)) pasteClips(Math.max(...selectedClips.map(clipEnd)));
  };
  const transportRef = useRef({ shuttle: shuttleTo, step: stepFrames, clipboard: clipboardCommand });
  useEffect(() => { transportRef.current = { shuttle: shuttleTo, step: stepFrames, clipboard: clipboardCommand }; });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      const meta = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const transport: Record<string, () => void> = meta ? {} : {
        j: () => transportRef.current.shuttle(-1), k: () => transportRef.current.shuttle(0), l: () => transportRef.current.shuttle(1),
        arrowleft: () => transportRef.current.step(event.shiftKey ? -10 : -1), arrowright: () => transportRef.current.step(event.shiftKey ? 10 : 1),
      };
      if (transport[key]) {
        event.preventDefault();
        return transport[key]();
      }
      // The app menu handles ⌘ shortcuts on desktop; the browser build and plain Ctrl on macOS come through here.
      const menuHandles = window.dashCutDesktop && (event.metaKey || !navigator.platform.startsWith("Mac"));
      if (meta && !menuHandles && ["a", "c", "x", "v", "d"].includes(key)) {
        event.preventDefault();
        return transportRef.current.clipboard(key === "a" ? "select-all" : key === "c" ? "copy" : key === "x" ? "cut" : key === "v" ? "paste" : "duplicate");
      }
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

  /* ------------------------------------------------------------ voice / background separation */

  /** Separates an asset once (cached on disk by the main process) and records the stem files on the project. */
  async function ensureStems(asset: Asset): Promise<boolean> {
    if (project.stems?.[asset.id]) return true;
    const desktop = window.dashCutDesktop;
    if (!desktop || !asset.sourcePath) { setToast(t("声音分离仅支持桌面版")); return false; }
    if (separating) { setToast(t("正在分离，请稍候")); return false; }
    try {
      if (!separationReady.model) {
        setSeparating(t("正在下载声音分离模型（约 80 MB）…"));
        await desktop.installSeparation();
        setSeparationReady((value) => ({ ...value, model: true }));
      }
      setSeparating(t("正在分离人声与背景音…"));
      const stems = await desktop.separateAudio(asset.sourcePath);
      commit((state) => ({ ...state, stems: { ...state.stems, [asset.id]: { voice: stems.vocals, background: stems.background } } }));
      return true;
    } catch (error) {
      setToast(error instanceof Error ? error.message : t("声音分离失败"));
      return false;
    } finally {
      setSeparating(null);
      setCaptionProgress(null);
    }
  }

  async function separateSelected(mode: "voice" | "background") {
    const clipId = primaryClip?.id;
    if (!clipId || !primaryAsset) return;
    if (!await ensureStems(primaryAsset)) return;
    commit((state) => {
      const clip = state.clips.find((item) => item.id === clipId);
      return clip ? updateClip(state, clipId, { audio: { ...clip.audio, separation: mode } }, options) : state;
    });
    setToast(mode === "voice" ? t("已切换为仅保留人声") : t("已切换为仅保留背景音"));
  }

  /* ------------------------------------------------------------ video translation */

  async function runTranslation({ language, voice, original }: TranslateRequest) {
    const desktop = window.dashCutDesktop;
    if (!desktop || translating) return;
    setTranslating(true);
    try {
      let subtitles = project.subtitles;
      if (subtitles.some((item) => !item[language].trim() && (item.zh.trim() || item.en.trim()))) {
        if (!aiConfig.baseUrl.trim() || !aiConfig.apiKey.trim() || !aiConfig.model.trim()) throw new Error(t("字幕缺少目标语言译文，请先在字幕面板填写 API 设置"));
        setCaptionProgress({ progress: 0, stage: t("正在翻译") });
        subtitles = await desktop.translateSubtitles({ config: aiConfig, subtitles });
      }
      setCaptionProgress({ progress: 0, stage: t("正在合成配音…") });
      const dub = await desktop.renderDub({ language, voice: voice || undefined, lines: subtitles.map((item) => ({ start: item.start, end: item.end, text: item[language] })) });
      const sources = project.clips.filter((clip) => {
        const asset = assetMap.get(clip.assetId);
        return asset?.kind === "video" && asset.hasAudio && project.tracks.find((track) => track.id === clip.trackId)?.kind === "video";
      });
      if (original === "background") {
        for (const asset of new Set(sources.map((clip) => assetMap.get(clip.assetId)!))) if (!await ensureStems(asset)) throw new Error(t("声音分离失败，配音未添加"));
      }
      const [url] = await desktop.registerMedia([dub.outputPath]);
      const name = language === "en" ? "Dub (English).wav" : "配音（中文）.wav";
      const asset: Asset = { id: uid("asset"), name, kind: "audio", url, sourcePath: dub.outputPath, duration: dub.duration, width: 0, height: 0, hasAudio: true, thumbnail: "", frames: [], peaks: [], peaksPerSecond: 0 };
      setAssets((items) => [...items, asset]);
      void desktop.extractWaveform(dub.outputPath).then((wave) => patchAsset(asset.id, { peaks: wave.peaks, peaksPerSecond: wave.peaksPerSecond })).catch(() => undefined);
      commit((state) => {
        const created = addTrack({ ...state, subtitles }, "audio", "bottom");
        let next = { ...created.project, clips: [...created.project.clips, createClip(asset, created.trackId, 0)] };
        for (const clip of sources) {
          const audio = original === "background" ? { ...clip.audio, separation: "background" as const } : original === "duck" ? { ...clip.audio, volume: Math.min(clip.audio.volume, 0.15), volumeKeyframes: undefined } : { ...clip.audio, muted: true };
          next = updateClip(next, clip.id, { audio }, options);
        }
        return pruneTracks(next);
      });
      setSubtitleMode(language);
      setTranslateOpen(false);
      const overflow = dub.lines.filter((line) => line.overflow > 0.05).length;
      setToast(overflow ? t("配音已添加到新音频轨；{count} 句即使加速仍超出字幕时长，可以手动调整", { count: overflow }) : t("配音已添加到新音频轨，字幕切换为译文"));
    } catch (error) {
      setToast(error instanceof Error ? error.message : t("视频翻译失败"));
    } finally {
      setTranslating(false);
      setCaptionProgress(null);
    }
  }

  /** Runs recognition (and optional translation); resolves with the message shown to the user. */
  async function generateSubtitles(verbatim = false, translate?: boolean): Promise<string> {
    let outcome = "";
    const notify = (message: string) => { outcome = message; setToast(message); };
    const withTranslation = translate ?? autoTranslate;
    if (isGenerating) return t("正在识别中，请稍候");
    if (recognitionEngine === "cloud" || withTranslation) {
      if (!window.dashCutDesktop) { notify(t("云端字幕仅支持桌面版")); return outcome; }
      if (!aiConfig.baseUrl.trim() || !aiConfig.apiKey.trim() || !aiConfig.model.trim()) {
        { notify(recognitionEngine === "cloud" ? t("请先填写 API Base URL、API Key 并选择模型") : t("请先填写 API 设置，或关闭自动翻译以离线识别")); return outcome; }
      }
    }
    const sources = captionSources();
    if (recognitionEngine === "local") {
      if (!window.dashCutDesktop) {
        notify(t("本地识别仅支持桌面版"));
        setHardwareOpen(true);
        return outcome;
      }
      if (!hardware?.runtime?.ready) {
        notify(t("本地 AI 运行时不可用，请重新安装 DashCut 极剪"));
        setHardwareOpen(true);
        void checkHardware();
        return outcome;
      }
      if (!localModels.find((model) => model.id === selectedModel)?.installed) {
        notify(t("请先下载安装 {model} 模型", { model: selectedModel }));
        setHardwareOpen(true);
        return outcome;
      }
      if (!sources.length) { notify(t("时间轴中没有含人声的视频或音频")); return outcome; }
      setIsGenerating(true);
      setCaptionProgress({ progress: 0, stage: t("正在加载本地模型") });
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
        setCaptionProgress({ progress: 1, stage: t("识别完成") });
        const generated = placeCaptions(sources, response.results, false);
        const transcripts = buildTranscripts(sources, response.results, "local");
        commit((state) => ({ ...state, subtitles: generated, transcripts: { ...state.transcripts, ...transcripts } }));
        if (withTranslation && generated.length) {
          notify(t("本地识别完成，正在生成中英译文…"));
          setCaptionProgress({ progress: 0, stage: t("正在翻译") });
          try {
            setSubtitles(await window.dashCutDesktop.translateSubtitles({ config: aiConfig, subtitles: generated }));
            notify(t("双语字幕完成 · {localModel} + {aiModel}（保留识别时间戳）", { localModel: response.model, aiModel: aiConfig.model }));
          } catch (error) {
            notify(t("已保留原语言字幕；翻译失败：{error}", { error: error instanceof Error ? error.message : t("请重试") }));
          }
        } else notify(t("本地识别完成 · {model} / {device}", { model: response.model, device: response.device }));
      } catch (error) {
        notify(error instanceof Error ? error.message : t("本地识别失败"));
      } finally {
        setIsGenerating(false);
        setCaptionProgress(null);
      }
      return outcome;
    }
    if (!window.dashCutDesktop) return t("仅支持桌面版");
    if (!sources.length) { notify(t("时间轴中没有含人声的视频或音频")); return outcome; }
    setIsGenerating(true);
    setCaptionProgress({ progress: 0, stage: t("正在提取音轨") });
    try {
      const response = await window.dashCutDesktop.transcribeCloud({ config: aiConfig, clips: sources.map((source) => ({ id: source.id, path: source.asset.sourcePath })) });
      const transcripts = buildTranscripts(sources, response.results.map((result) => ({ ...result, segments: result.segments.map((segment) => ({ ...segment, text: segment.zh || segment.text })) })), "cloud");
      const generated = placeCaptions(sources, response.results, true);
      commit((state) => ({ ...state, subtitles: generated, transcripts: { ...state.transcripts, ...transcripts } }));
      notify(response.failedChunks
        ? t("云端字幕完成，但有 {failed}/{total} 段识别失败，可重试或改用本地识别", { failed: response.failedChunks, total: response.totalChunks })
        : t("云端双语字幕完成，时间为模型估算；如整体偏早或偏晚，可用“时间偏移”一键校准"));
    } catch (error) {
      notify(error instanceof Error ? error.message : t("云端识别失败"));
    } finally {
      setIsGenerating(false);
      setCaptionProgress(null);
    }
    return outcome;
  }

  async function refreshAiModels() {
    if (!window.dashCutDesktop) return setToast(t("模型查询仅支持桌面版"));
    setLoadingAiModels(true);
    try {
      const models = await window.dashCutDesktop.listAiModels(aiConfig);
      setAiModels(models);
      const best = bestAudioModel(models);
      if (best) {
        setAiConfig((config) => ({ ...config, model: best }));
        setToast(t("已查询 {count} 个模型，已自动选择识别效果最好的 {model}", { count: models.length, model: best }));
      } else setToast(t("已查询 {count} 个模型，但没有找到支持音频输入的 Gemini 模型，请手动选择", { count: models.length }));
    } catch (error) { setToast(error instanceof Error ? error.message : t("模型查询失败")); }
    finally { setLoadingAiModels(false); }
  }

  async function translateExistingSubtitles() {
    if (!window.dashCutDesktop || isGenerating || !project.subtitles.length) return;
    if (!aiConfig.baseUrl.trim() || !aiConfig.apiKey.trim() || !aiConfig.model.trim()) return setToast(t("请先填写 API Base URL、API Key 并选择模型"));
    setIsGenerating(true);
    setCaptionProgress({ progress: 0, stage: t("正在翻译") });
    try {
      setSubtitles(await window.dashCutDesktop.translateSubtitles({ config: aiConfig, subtitles: project.subtitles }));
      setToast(t("中英译文已更新，字幕时间保持不变"));
    } catch (error) { setToast(error instanceof Error ? error.message : t("翻译失败，原字幕已保留")); }
    finally { setIsGenerating(false); setCaptionProgress(null); }
  }

  // Changing a start moves this caption and every later one; extending an end pushes later captions only on overlap.

  function shiftCaptions(delta: number, fromSelected: boolean) {
    if (!project.subtitles.length) return;
    setSubtitles(shiftSubtitles(project.subtitles, delta, fromSelected ? selectedSubtitle : null), "caption-shift");
    const seconds = Math.abs(delta);
    setToast(fromSelected
      ? (delta > 0 ? t("选中及之后的字幕已延后 {seconds} 秒", { seconds }) : t("选中及之后的字幕已提前 {seconds} 秒", { seconds }))
      : (delta > 0 ? t("全部字幕已延后 {seconds} 秒", { seconds }) : t("全部字幕已提前 {seconds} 秒", { seconds })));
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
      setToast(t("硬件检测失败，请重新启动桌面应用"));
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
      setToast(t("{model} 模型安装完成", { model }));
    } catch (error) {
      setToast(error instanceof Error ? error.message : t("{model} 模型安装失败", { model }));
    } finally {
      setInstallingModel("");
    }
  }

  async function removeLocalModel(model: LocalModelInfo["id"]) {
    if (!window.dashCutDesktop) return;
    await window.dashCutDesktop.removeLocalModel(model);
    setLocalModels(await window.dashCutDesktop.getLocalModels());
    setToast(t("{model} 模型已删除", { model }));
  }


  /* ------------------------------------------------------------ export & cover */

  async function runHealthCheck() {
    if (!window.dashCutDesktop) return setToast(t("发布前检查仅支持桌面版"));
    if (!project.clips.length) return setToast(t("时间轴是空的"));
    setHealth({ running: true, issues: null });
    setProgressStage("");
    const issues: HealthIssue[] = [];
    try {
      // Missing media first: analysis cannot render clips whose files are gone.
      const used = assets.filter((asset) => asset.kind !== "text" && usedAssets.has(asset.id));
      const present = await window.dashCutDesktop.mediaExists(used.map((asset) => asset.sourcePath));
      const missing = used.filter((_, index) => !present[index]);
      for (const asset of missing) issues.push({ id: `missing-${asset.id}`, severity: "error", title: t("缺少素材：{name}", { name: asset.name }), detail: asset.sourcePath || t("没有本地路径"), fix: "relink" });
      const canvas = canvasSize(ratio, exportResolution);
      const context = document.createElement("canvas").getContext("2d")!;
      issues.push(...captionIssues(project.subtitles, subtitleStyle, subtitleMode, canvas, (text, fontPx) => {
        context.font = `700 ${fontPx}px ${subtitleStyle.fontFamily}`;
        return context.measureText(text).width;
      }));
      if (!missing.length) {
        setProgressStage(t("正在渲染并测量成片…"));
        const request = toComposition(project, assets, { ratio, resolution: 720, fps: 30, platform, subtitleStyle, subtitleMode });
        // Titles are skipped here: they cannot change loudness, black frames or silence.
        issues.push(...analysisIssues(await window.dashCutDesktop.analyzeComposition(request), exportFormat === "gif" ? null : loudnessTarget));
      }
      setHealth({ running: false, issues });
    } catch (error) {
      setHealth({ running: false, issues });
      setToast(error instanceof Error ? t("检查未完成：{error}", { error: error.message }) : t("检查未完成"));
    }
  }

  function fixHealthIssue(issue: HealthIssue) {
    if (issue.fix === "loudness") {
      setLoudnessTarget(-14);
      setHealth((state) => ({ ...state, issues: state.issues?.filter((item) => item.fix !== "loudness") ?? null }));
      return setToast(t("已开启响度标准化（-14 LUFS），导出时自动修正"));
    }
    if (issue.fix === "relink") {
      setMissingAssets(assets.filter((asset) => issue.id === `missing-${asset.id}`).map((asset) => asset.id));
      return setHealthOpen(false);
    }
    if (issue.fix === "caption" && issue.captionId !== undefined) {
      setSelectedSubtitle(issue.captionId);
      setLeftTab("subtitles");
      if (issue.time !== undefined) seek(issue.time + 0.05);
      setHealthOpen(false);
      setExportOpen(false);
    }
  }

  function exportOutput(): CompositionOutput {
    return { format: exportFormat, codec: exportCodec, loudnessTarget: exportFormat === "gif" ? null : loudnessTarget, gif: { fps: 12, width: ratio === "9:16" ? 360 : 480, maxDuration: 15 } };
  }

  function applyExportPreset(preset: ExportPreset) {
    setExportFormat(preset.format);
    setExportCodec(preset.codec);
    setLoudnessTarget(preset.loudness);
    if (preset.resolution) setExportResolution(preset.resolution);
    if (preset.fps) setExportFps(preset.fps);
    if (preset.platform) setPlatform(preset.platform);
    if (preset.ratio && preset.ratio !== ratio) {
      setRatio(preset.ratio);
      setToast(t("画布已改为 {ratio}；横版素材可用「智能转竖屏」自动取景", { ratio: preset.ratio }));
    }
  }

  async function startExport() {
    if (!window.dashCutDesktop) return setToast(t("真实视频导出仅支持桌面版"));
    if (!project.clips.length) return setToast(t("请先把素材拖到时间轴"));
    if (project.clips.some((clip) => { const asset = assetMap.get(clip.assetId); return asset?.kind !== "text" && !asset?.sourcePath; })) return setToast(t("部分素材缺少本地路径，请重新导入"));
    setExporting(true);
    setExportResult(null);
    setProgress(0);
    setProgressStage(t("正在准备导出"));
    try {
      // Titles are rasterised with the preview's renderer at the export height so they look identical.
      const { height } = canvasSize(ratio, exportResolution);
      const textLayers = new Map<string, TextLayer>();
      for (const clip of project.clips.filter((item) => item.text && assetMap.get(item.assetId)?.kind === "text")) {
        const raster = rasterizeText(clip.text!, height);
        const path = await window.dashCutDesktop.writeExportLayer(raster.bytes.buffer as ArrayBuffer);
        textLayers.set(clip.id, { path, width: raster.width, height: raster.height, boxWidth: raster.boxWidth, boxHeight: raster.boxHeight });
      }
      const request = { ...toComposition(project, assets, { ratio, resolution: exportResolution, fps: exportFps, platform, subtitleStyle, subtitleMode }, textLayers), output: exportOutput() };
      const result = await window.dashCutDesktop.exportComposition(request);
      if (!result.canceled && result.outputPath) {
        setExportResult({ outputPath: result.outputPath, subtitleFiles: result.subtitleFiles ?? [] });
        setProgress(100);
        setProgressStage(t("导出完成"));
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : t("视频导出失败"));
    } finally {
      setExporting(false);
    }
  }

  /** The picture the cover frame picker shows at a timeline time: the main track first, then any visible overlay. */
  function coverFrameAt(time: number): FrameSource {
    const visual = (clip: Clip | null | undefined) => {
      const asset = clip && assetMap.get(clip.assetId);
      return asset && asset.kind !== "audio" && asset.kind !== "text" ? { asset, sourceTime: sourceTimeAt(clip, time) } : null;
    };
    const main = mainTrack(project).id;
    const fromMain = visual(clipAt(project, main, time));
    if (fromMain) return fromMain;
    for (const track of project.tracks) if (track.kind === "video" && !track.hidden && track.id !== main) {
      const found = visual(clipAt(project, track.id, time));
      if (found) return found;
    }
    return null;
  }

  const mainThumb = assetMap.get(trackClips(project, mainTrack(project).id)[0]?.assetId ?? "")?.thumbnail ?? "";
  const filteredAssets = assets.filter((asset) => asset.kind !== "text").filter((asset) => mediaFilter === "all" || (mediaFilter === "image" ? asset.kind === "image" || asset.kind === "gif" : asset.kind === mediaFilter));
  const primaryId = primaryClip?.id;
  const changeClip = useCallback((patch: Partial<Clip>, key: string) => {
    if (!primaryId) return;
    commit((state) => updateClip(state, primaryId, patch, options), `${primaryId}-${key}`);
  }, [commit, options, primaryId]);

  /** One undo step that also records canvas/caption settings, so undo restores them together with the clips. */
  function commitWithView(nextProject: Project, after: Partial<NonNullable<Project["view"]>>) {
    const before = { ratio, captionStyle: subtitleStyle as unknown as Record<string, unknown>, captionMode: subtitleMode };
    setHistory((state) => ({ past: [...state.past.slice(-99), { ...state.present, view: before }], present: { ...nextProject, view: { ...before, ...after } }, future: [], key: "", at: Date.now(), revision: state.revision + 1 }));
  }

  /* ------------------------------------------------------------ smart reframe */

  async function runReframe() {
    if (!window.dashCutDesktop) return setToast(t("智能转竖屏仅支持桌面版"));
    const targets = (reframeOptions.scope === "selected" ? selectedClips : trackClips(project, mainTrack(project).id))
      .filter((clip) => assetMap.get(clip.assetId)?.kind === "video" && clip.freezeAt === null && !clip.reverse);
    if (!targets.length) return setToast(reframeOptions.scope === "selected" ? t("请先选择视频片段") : t("主轨上没有可以转竖屏的视频"));
    setReframeOpen(false);
    const canvasRatio = reframeOptions.switchCanvas ? "9:16" : ratio;
    try {
      setBusy(t("正在加载人脸检测模型…"));
      const { loadFaceDetector, trackSubject } = await import("./editor/face-tracking");
      const detector = await loadFaceDetector(() => window.dashCutDesktop!.faceModel());
      let next = project;
      let faces = 0;
      let samples = 0;
      for (const [index, clip] of targets.entries()) {
        const asset = assetMap.get(clip.assetId)!;
        const tracked = await trackSubject(asset, clip, detector, 0.25, (fraction) => setBusy(t("正在跟踪主体 {current}/{total} · {percent}%", { current: index + 1, total: targets.length, percent: Math.round(fraction * 100) })));
        const quarter = clip.rotate90 === 90 || clip.rotate90 === 270;
        const mediaAspect = (asset.width * clip.crop.w) / (asset.height * clip.crop.h);
        const result = computeReframe(tracked, { mediaAspect: quarter ? 1 / mediaAspect : mediaAspect, canvasAspect: canvasRatio === "9:16" ? 9 / 16 : 16 / 9, tracking: reframeOptions.tracking });
        faces += result.detected;
        samples += tracked.length;
        next = { ...next, clips: next.clips.map((item) => item.id === clip.id ? { ...item, transform: { ...item.transform, scale: result.scale, x: 0 }, keyframes: { ...item.keyframes, x: result.keyframes } } : item) };
      }
      commitWithView(next, { ratio: canvasRatio });
      setRatio(canvasRatio);
      setToast(faces ? t("已为 {count} 个片段生成跟随主体的竖屏取景（{percent}% 画面检测到人脸），可在「画面」中微调关键帧", { count: targets.length, percent: Math.round((faces / samples) * 100) }) : t("没有检测到人脸，已居中裁切；可在「画面」中手动调整位置"));
    } catch (error) {
      setToast(error instanceof Error ? t("智能转竖屏失败：{error}", { error: error.message }) : t("智能转竖屏失败"));
    } finally {
      setBusy("");
    }
  }

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
      if (event.type === "stopped") return pushAgent({ id: uid("msg"), kind: "status", text: t("已停止。已经应用的修改可以用撤销恢复。") });
      if (event.type === "tool-call" && event.name !== "propose_plan" && event.name !== "apply_edits") {
        return pushAgent({ id: `tool-${event.id}`, kind: "tool", name: event.name, status: "running", detail: "" });
      }
      if (event.type === "tool-result") {
        const result = event.result as { error?: string; ok?: boolean; issues?: Array<{ message: string }> } | null;
        if (event.name === "apply_edits" && result?.ok === false) return pushAgent({ id: uid("msg"), kind: "status", text: t("修改未通过校验，助手正在调整：{issues}", { issues: result.issues?.map((issue) => issue.message).slice(0, 2).join("；") ?? "" }) });
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
    if (!window.dashCutDesktop) return setToast(t("极剪助手仅支持桌面版"));
    planApproved.current = false;
    pushAgent({ id: uid("msg"), kind: "user", text });
    setAgentRunning(true);
    window.dashCutDesktop.agentSend({ message: text, system: agentSystemPrompt(skill), tools: agentToolSpecs }).catch((error) => {
      setAgentRunning(false);
      pushAgent({ id: uid("msg"), kind: "error", text: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : t("发送失败") });
    });
  }

  function decidePlan(id: string, approved: boolean, feedback: string) {
    setAgentMessages((items) => items.map((item) => item.id === id && item.kind === "plan" ? { ...item, decision: approved ? "approved" : "rejected", feedback } : item));
    planResolvers.current.get(id)?.({ approved, feedback });
    planResolvers.current.delete(id);
  }

  function undoAgentEdit(id: string) {
    if (editRevisions.current.get(id) !== history.revision) return setToast(t("这次修改之后还有其他编辑，请用 ⌘Z 逐步撤销"));
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
      title: projectMeta.title.trim() || t("未命名项目"),
      createdAt: projectMeta.createdAt,
      ratio,
      project,
      assets,
      captionStyle: subtitleStyle,
      captionMode: subtitleMode,
      exportSettings: { resolution: exportResolution, fps: exportFps, platform, format: exportFormat, codec: exportCodec, loudnessTarget },
      cover,
    };
  }

  // Everything that is written to disk except the save timestamp; changes mark the project dirty.
  const fingerprint = useMemo(() => {
    const doc = buildDocument({ id: projectMeta.id, title: projectMeta.title, createdAt: projectMeta.createdAt, ratio, project, assets, captionStyle: subtitleStyle, captionMode: subtitleMode, exportSettings: { resolution: exportResolution, fps: exportFps, platform, format: exportFormat, codec: exportCodec, loudnessTarget }, cover }, new Date(0));
    return JSON.stringify(doc);
  }, [assets, cover, exportCodec, exportFormat, exportFps, exportResolution, loudnessTarget, platform, project, projectMeta, ratio, subtitleMode, subtitleStyle]);
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
    if (!window.dashCutDesktop) return setToast(t("保存项目仅支持桌面版"));
    if (recording !== "idle") return setToast(t("请先停止录音"));
    const unsaved = assets.filter((asset) => !asset.sourcePath && usedAssets.has(asset.id));
    if (unsaved.length) setToast(t("{count} 个素材没有本地路径，将不会被保存", { count: unsaved.length }));
    const state = editorState();
    try {
      const result = await window.dashCutDesktop.saveProject({ document: buildDocument(state), projectPath, saveAs });
      if (result.canceled || !result.projectPath) return false;
      setProjectPath(result.projectPath);
      setSavedFingerprint(fingerprint);
      setToast(t("项目已保存 · {name}", { name: result.projectPath.split("/").pop() ?? "" }));
      return true;
    } catch (error) {
      setToast(error instanceof Error ? t("保存失败：{error}", { error: error.message }) : t("保存失败"));
      return false;
    }
  }

  async function refreshRecent() {
    if (window.dashCutDesktop) setRecentProjects(await window.dashCutDesktop.recentProjects());
  }

  function confirmDiscard() {
    return !dirty || window.confirm(t("当前项目有未保存的修改，继续将丢弃这些修改。确定继续吗？"));
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
    setExportFormat(state.exportSettings.format ?? "mp4");
    setExportCodec(state.exportSettings.codec ?? "h264");
    setLoudnessTarget(state.exportSettings.loudnessTarget === undefined ? -14 : state.exportSettings.loudnessTarget);
    setPlatform(state.exportSettings.platform);
    setCover(state.cover);
    setCoverImage("");
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
    if (!window.dashCutDesktop) return setToast(t("打开项目仅支持桌面版"));
    if (!confirmDiscard()) return;
    try {
      const result = await window.dashCutDesktop.openProject(target);
      if (result.canceled || !result.document) return;
      const state = await documentToState(result.document);
      await loadEditorState(state, result.projectPath ?? "", result.missing ?? [], true);
      setToast(result.missing?.length ? t("项目已打开，{count} 个素材需要重新定位", { count: result.missing.length }) : t("已打开「{title}」", { title: state.title }));
    } catch (error) {
      setToast(error instanceof Error ? t("无法打开项目：{error}", { error: error.message }) : t("无法打开项目"));
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
      setToast(t("已恢复「{title}」，请保存项目", { title: state.title }));
    } catch (error) {
      setToast(error instanceof Error ? t("恢复失败：{error}", { error: error.message }) : t("恢复失败"));
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
    setToast(t("已重新定位 {count} 个素材", { count: updates.length }));
  }

  useEffect(() => {
    if (!window.dashCutDesktop) return;
    void window.dashCutDesktop.recoveryList().then(setRecoveries).catch(() => undefined);
  }, []);

  const commandRef = useRef<(command: string) => void>(() => undefined);
  useEffect(() => {
    commandRef.current = (command: string) => {
      const typing = isTyping(document.activeElement);
      if (command === "select-all") {
        if (typing) return void window.dashCutDesktop?.nativeEdit("selectAll");
        return clipboardCommand("select-all");
      }
      if (["copy", "cut", "paste", "duplicate"].includes(command)) {
        if (typing) return void window.dashCutDesktop?.nativeEdit(command === "duplicate" ? "copy" : command as "copy" | "cut" | "paste");
        return clipboardCommand(command as "copy" | "cut" | "paste" | "duplicate");
      }
      if (command === "undo" || command === "redo") {
        if (typing) return void window.dashCutDesktop?.nativeEdit(command);
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
    <button className="upload-card" onClick={() => fileInputRef.current?.click()}><span>＋</span><strong>{t("导入素材")}</strong><small>{t("视频、图片、动图、音频可混合多选")}</small></button>
    <div className="media-filters">{(["all", "video", "image", "audio"] as const).map((filter) => <button key={filter} className={mediaFilter === filter ? "active" : ""} onClick={() => setMediaFilter(filter)}>{filter === "all" ? t("全部 {count}", { count: assets.length }) : filter === "image" ? t("图片") : t(kindLabels[filter])}</button>)}</div>
    <div className="asset-grid">{filteredAssets.map((asset) => <div key={asset.id} className={`asset-card${usedAssets.has(asset.id) ? " used" : ""}${selectedAssets.includes(asset.id) ? " selected" : ""}`} onClick={(event) => {
      // ⌘/Ctrl toggles, Shift extends from the last selected card, a plain click selects one.
      if (event.metaKey || event.ctrlKey) return setSelectedAssets((ids) => ids.includes(asset.id) ? ids.filter((id) => id !== asset.id) : [...ids, asset.id]);
      if (event.shiftKey && selectedAssets.length) {
        const order = filteredAssets.map((item) => item.id);
        const [from, to] = [order.indexOf(selectedAssets.at(-1)!), order.indexOf(asset.id)].sort((a, b) => a - b);
        return setSelectedAssets(order.slice(from, to + 1));
      }
      setSelectedAssets([asset.id]);
    }} draggable onDragStart={(event) => { event.dataTransfer.setData("application/x-dashcut-asset", asset.id); event.dataTransfer.effectAllowed = "copy"; setDraggingAssetId(asset.id); }} onDragEnd={() => setDraggingAssetId(null)} onDoubleClick={() => appendAsset(asset)} title={t("拖到时间轴，或双击添加到末尾")}>
      <div className="asset-thumb" style={asset.thumbnail ? { backgroundImage: `url("${asset.thumbnail}")` } : undefined}>
        {asset.kind === "audio" && <Icon name="music" size={22} />}
        <span className="asset-kind">{t(kindLabels[asset.kind])}</span>
        {asset.kind !== "image" && <span className="asset-duration">{formatClock(asset.duration, false)}</span>}
        {usedAssets.has(asset.id) && <span className="asset-used">{t("已添加")}</span>}
        <button className="asset-add" title={t("添加到时间轴")} onClick={() => appendAsset(asset)}><Icon name="plus" size={13} /></button>
        <button className="asset-remove" title={t("从素材库移除")} onClick={() => removeAsset(asset)}>×</button>
      </div>
      <strong>{asset.name}</strong>
    </div>)}</div>
    {!assets.length && <p className="empty-hint">{t("导入的素材会按导入顺序显示在这里，不会自动放入时间轴。把素材拖到时间轴的轨道上即可使用；拖到轨道上方的空白处会新建画中画轨，用来叠加图片和视频。")}</p>}
  </>;

  const percent = captionProgress ? Math.round(captionProgress.progress * 100) : 0;
  const subtitlesPanel = <>
    <div className="language-switch"><button className={subtitleMode === "zh" ? "active" : ""} onClick={() => setSubtitleMode("zh")}>{t("中文")}</button><button className={subtitleMode === "en" ? "active" : ""} onClick={() => setSubtitleMode("en")}>English</button><button className={subtitleMode === "both" ? "active" : ""} onClick={() => setSubtitleMode("both")}>{t("中英双语")}</button></div>
    <div className="engine-switch"><button className={recognitionEngine === "cloud" ? "active" : ""} onClick={() => setRecognitionEngine("cloud")}><b>☁</b><span>{t("云端模型")}<small>{t("需要网络 · 估算时间")}</small></span></button><button className={recognitionEngine === "local" ? "active" : ""} onClick={() => { setRecognitionEngine("local"); void checkHardware(); }}><b>⌁</b><span>{t("本地模型")}<small>{t("离线 · 精确时间")}</small></span></button></div>
    <details className="ai-settings" open={!aiConfig.baseUrl || !aiConfig.model}>
      <summary>{t("API 设置")}{aiConfig.model ? ` · ${aiConfig.model}` : ""}</summary>
      <label>API Base URL<input value={aiConfig.baseUrl} placeholder="https://…/v1" disabled={isGenerating || loadingAiModels} onChange={(event) => { setAiModels([]); setAiConfig({ ...aiConfig, baseUrl: event.target.value }); }} /></label>
      <label>API Key<span className="model-picker"><input type={showAiKey ? "text" : "password"} autoComplete="off" spellCheck={false} value={aiConfig.apiKey} disabled={isGenerating || loadingAiModels} onChange={(event) => setAiConfig({ ...aiConfig, apiKey: event.target.value })} placeholder={t("加密保存在本机钥匙串，下次自动填入")} /><button className="ghost-action" type="button" onClick={() => setShowAiKey(!showAiKey)}>{showAiKey ? t("隐藏") : t("显示")}</button></span></label>
      <label>{t("模型")}<span className="model-picker"><input list="ai-models" value={aiConfig.model} placeholder={t("选择或输入模型 ID")} disabled={isGenerating} onChange={(event) => setAiConfig({ ...aiConfig, model: event.target.value })} /><button className="ghost-action" disabled={loadingAiModels || isGenerating} onClick={() => void refreshAiModels()}>{loadingAiModels ? t("查询中…") : aiModels.length ? t("刷新 ({count})", { count: aiModels.length }) : t("查询")}</button></span><datalist id="ai-models">{aiModels.map((model) => <option key={model.id} value={model.id} />)}</datalist></label>
      {recognitionEngine === "local" && <label className="ai-checkbox"><input type="checkbox" checked={autoTranslate} disabled={isGenerating} onChange={(event) => setAutoTranslate(event.target.checked)} />{t("识别后自动生成中英译文")}</label>}
      <small>{recognitionEngine === "cloud" ? t("云端识别会上传音轨，需选择支持音频输入的模型。") : autoTranslate ? t("本地识别后仅将字幕文本发送到接口翻译。") : t("关闭自动翻译时，本地识别完全离线。")}</small>
      <button className="ghost-action" disabled={isGenerating || !project.subtitles.length} onClick={() => void translateExistingSubtitles()}>{t("翻译当前字幕 · 保留时间戳")}</button>
    </details>
    {recognitionEngine === "local" && <label className="hotwords-field">{t("专有名词")}<input value={hotwords} disabled={isGenerating} placeholder={t("人名、品牌、术语，空格分隔")} onChange={(event) => setHotwords(event.target.value)} /></label>}
    <button className={`generate-button${isGenerating ? " running" : ""}`} onClick={() => void generateSubtitles()} disabled={isGenerating}>
      <span>{isGenerating ? "◌" : "✦"}</span>
      <strong>{isGenerating ? t("正在识别 {percent}%", { percent }) : t("识别字幕")}</strong>
      <small>{isGenerating ? captionProgress?.stage || t("正在准备") : t("普通话 / English · 自动断句")}</small>
      {isGenerating && <i className="caption-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${percent}%` }} /></i>}
    </button>
    <div className="recognition-meta"><span><i></i> {recognitionEngine === "cloud" ? t("云端识别 · 估算时间") : hardware?.assessment.tier === "recommended" ? t("本地模式 · 推荐配置") : t("本地模式 · 需要检测")}</span><button onClick={() => setStyleOpen(!styleOpen)}>{t("字幕样式")} {styleOpen ? "⌃" : "⌄"}</button></div>
    {styleOpen && <CaptionStyleEditor style={subtitleStyle} onChange={setSubtitleStyle} />}
    {project.subtitles.length > 0 && <CaptionTimingBar disabled={isGenerating} selected={selectedSubtitle !== null && project.subtitles.some((item) => item.id === selectedSubtitle)} onShift={shiftCaptions} />}
    <p className="empty-hint caption-edit-hint">{project.subtitles.length ? t("字幕在时间轴的字幕轨上编辑：双击文字修改，拖动两端调整时间，双击空白处新建，选中后按 ⌫ 删除。") : t("把含人声的视频或音频拖到时间轴，选择识别模型后生成字幕。")}</p>
  </>;

  const cropClip = cropOpen ? primaryClip : null;
  const cropAsset = cropClip ? assetMap.get(cropClip.assetId) : undefined;

  // Keyed by language so memoised panels re-render their text after switching.
  return <main className="app-shell" key={language} lang={language === "zh" ? "zh-CN" : "en"}>
    <input ref={fileInputRef} className="hidden-input" type="file" accept="video/*,image/*,audio/*" multiple onChange={importFiles} />
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><i></i><i></i></span><strong>DashCut <em>极剪</em></strong></div>
      <div className="project-title">
        <div className="project-menu">
          <button className="project-menu-button" title={t("项目菜单")} onClick={() => { setProjectMenuOpen(!projectMenuOpen); if (!projectMenuOpen) void refreshRecent(); }}><Icon name="film" size={14} /></button>
          {projectMenuOpen && <div className="project-popover" onMouseLeave={() => setProjectMenuOpen(false)}>
            <button onClick={() => { setProjectMenuOpen(false); void newProject(); }}>{t("新建项目")}<kbd>⌘N</kbd></button>
            <button onClick={() => { setProjectMenuOpen(false); void openProject(); }}>{t("打开项目…")}<kbd>⌘O</kbd></button>
            <button onClick={() => { setProjectMenuOpen(false); void saveProject(false); }}>{t("保存")}<kbd>⌘S</kbd></button>
            <button onClick={() => { setProjectMenuOpen(false); void saveProject(true); }}>{t("另存为…")}<kbd>⇧⌘S</kbd></button>
            {recentProjects.length > 0 && <><b>{t("最近项目")}</b>{recentProjects.map((item) => <button key={item.path} className={item.exists ? "" : "missing"} title={item.path} onClick={() => { setProjectMenuOpen(false); if (item.exists) void openProject(item.path); else void window.dashCutDesktop?.removeRecentProject(item.path).then(refreshRecent); }}>{item.title}<small>{item.exists ? item.path.split("/").slice(-2, -1)[0] : t("文件已移动，点击移除")}</small></button>)}</>}
          </div>}
        </div>
        <div><input className="project-name" aria-label={t("项目名称")} value={projectMeta.title} onChange={(event) => setProjectMeta((meta) => ({ ...meta, title: event.target.value }))} onBlur={(event) => { if (!event.target.value.trim()) setProjectMeta((meta) => ({ ...meta, title: t("未命名项目") })); }} /><span>{dirty ? t("未保存") : projectPath ? t("已保存") : t("未保存到磁盘")} · {formatClock(duration, false)} · {t("{count} 个片段", { count: project.clips.length })}</span></div>
      </div>
      <div className="top-actions"><button className="language-toggle" title={t("切换界面语言")} onClick={() => switchLanguage(language === "zh" ? "en" : "zh")}><b className={language === "zh" ? "on" : ""}>中</b><b className={language === "en" ? "on" : ""}>EN</b></button><button className="ghost hide-mobile" onClick={() => setAboutOpen(true)}>{t("关于与许可")}</button><button className={`agent-button${agentOpen ? " active" : ""}`} title={t("极剪助手（⌘J）")} onClick={() => agentOpen ? setAgentOpen(false) : void openAgent()}>✦ {t("极剪助手")}</button><button className="export-button" onClick={() => setExportOpen(true)}>{t("导出视频")} <span>↗</span></button></div>
    </header>

    <section className="workspace">
      <aside className="side-panel" onPointerDownCapture={() => { focusZone.current = "library"; }}>
        <nav className="panel-tabs">{([["media", "film", "素材"], ["text", "text", "文本"], ["transcript", "transcript", "文稿"], ["subtitles", "captions", "自动字幕"]] as const).map(([key, icon, label]) => <button key={key} className={leftTab === key ? "active" : ""} onClick={() => setLeftTab(key)}><Icon name={icon} size={18} /><span>{t(label)}</span></button>)}</nav>
        <div className="panel-scroll">{leftTab === "media" ? mediaPanel : leftTab === "text" ? <>
          <p className="empty-hint">{t("点击添加到播放头位置；选中后在右侧「文本」中修改文字和样式。")}</p>
          <div className="text-presets-grid">{textPresets.map((preset) => <button key={preset.id} onClick={() => addText(preset.style)} title={t("添加到播放头")}>
            <b style={{ fontFamily: preset.style.fontFamily ?? defaultTextStyle.fontFamily, fontWeight: preset.style.bold === false ? 400 : 700, fontStyle: preset.style.italic ? "italic" : "normal", color: preset.style.color ?? "#fff", WebkitTextStroke: preset.style.strokeWidth ? `1px ${preset.style.strokeColor}` : undefined, background: preset.style.backgroundOpacity ? preset.style.backgroundColor : "transparent" }}>Aa</b>
            <span>{t(preset.label)}</span>
          </button>)}</div>
        </> : leftTab === "transcript" ? <TranscriptPanel blocks={transcriptBlocks} time={current} flagged={flaggedWords} busy={isGenerating} canTranscribe={captionSources().length > 0} onSeek={seek} onDelete={deleteTranscriptWords} onTranscribe={() => void generateSubtitles(true)} onCleanCut={() => void smartTalk()} /> : subtitlesPanel}</div>
      </aside>

      <section className="stage">
        <div className="stage-toolbar"><span>{busy || (hoverTime !== null && toggles.previewAxis && !playing ? t("预览轴 {time}", { time: formatClock(hoverTime) }) : "")}</span><div className="stage-actions"><button className="ghost-action reframe-button" title={t("跟随人脸自动裁切为竖屏")} onClick={() => setReframeOpen(true)}>✦ {t("智能转竖屏")}</button><div className="segmented ratio-switch"><button className={ratio === "16:9" ? "active" : ""} onClick={() => setRatio("16:9")}>{t("16:9 横屏")}</button><button className={ratio === "9:16" ? "active" : ""} onClick={() => setRatio("9:16")}>{t("9:16 竖屏")}</button></div></div></div>
        <Preview project={project} assets={assetMap} time={previewTime} rate={playing ? shuttle : 0} muted={muted} ratio={ratio} subtitleMode={subtitleMode} subtitleStyle={subtitleStyle} stemUrls={stemUrls} onImport={() => fileInputRef.current?.click()} />
        <div className="player-controls"><span>{formatClock(current, true, exportFps)} <i>/ {formatClock(duration, true, exportFps)}</i>{playing && shuttle !== 1 && <em className="shuttle-badge">{shuttle > 0 ? "▶" : "◀"} {Math.abs(shuttle)}×</em>}</span><div><button title={t("回到开头")} onClick={() => seek(0)}><Icon name="prev" size={14} /></button><button data-play-toggle className="play" onClick={togglePlay} title={t("播放 / 暂停（空格）")}><Icon name={playing ? "pause" : "play"} size={14} /></button><button title={t("跳到结尾")} onClick={() => seek(duration)}><Icon name="next" size={14} /></button></div><div><LoudnessMeter active={playing && !muted} target={loudnessTarget} /><button title={muted ? t("取消静音") : t("静音预览")} onClick={() => setMuted(!muted)}><Icon name={muted ? "mute" : "volume"} size={15} /></button><button title={t("全屏预览")} onClick={() => void document.querySelector(".video-frame")?.requestFullscreen()}><Icon name="fullscreen" size={14} /></button></div></div>
      </section>

      {agentOpen
        ? <AgentPanel messages={agentMessages} running={agentRunning} config={agentConfig} skills={agentSkills} onSend={sendToAgent} onStop={() => void window.dashCutDesktop?.agentStop()} onReset={() => void resetAgent()} onPlan={decidePlan} onUndo={undoAgentEdit}
            onSaveConfig={async (config) => { if (!window.dashCutDesktop) return; try { setAgentConfig(await window.dashCutDesktop.saveAgentConfig(config)); setToast(t("助手设置已保存")); } catch (error) { setToast(error instanceof Error ? error.message : t("保存失败")); } }} onClose={() => setAgentOpen(false)} />
        : <Inspector clip={primaryClip} asset={primaryAsset} tab={inspectorTab} time={current} transitionAllowed={transitionAllowed} onTab={setInspectorTab} onChange={changeClip} onCrop={() => runAction("crop")} onSeek={seek}
            separation={{ available: separationReady.runtime, hasStems: Boolean(primaryAsset && project.stems?.[primaryAsset.id]), busy: separating ? `${separating}${captionProgress ? ` ${Math.round(captionProgress.progress * 100)}%` : ""}` : null }}
            onSeparate={(mode) => void separateSelected(mode)} onTranslate={() => setTranslateOpen(true)} />}
    </section>

    <section className="timeline-area" onPointerDownCapture={(event) => { focusZone.current = (event.target as HTMLElement).closest(".caption-track") ? "captions" : "timeline"; }}>
      <TimelineToolbar mode={mode} onMode={setMode} canUndo={history.past.length > 0} canRedo={history.future.length > 0} hasSelection={selectedClips.length > 0} canDelete={selectedClips.length > 0 || selectedSubtitles.length > 0} selectionIsVideo={primaryAsset?.kind === "video" && primaryClip?.freezeAt === null} recording={recording} toggles={toggles} zoom={zoom} settings={timelineSettings}
        onAction={runAction} onToggle={(key) => setToggles((value) => ({ ...value, [key]: !value[key] }))} onZoom={(value) => setZoom(clampZoom(value))} onSettings={setTimelineSettings} />
      <Timeline project={project} assets={assetMap} time={current} hoverTime={hoverTime} duration={duration} selection={selection} mode={mode} toggles={toggles} zoom={zoom} settings={timelineSettings} coverImage={coverImage || mainThumb} fps={exportFps} onTransition={(clipId) => { setSelection([clipId]); setInspectorTab("animation"); setAgentOpen(false); }} draggingAssetId={draggingAssetId}
        onSeek={seek} onHover={setHoverTime} onSelect={(ids) => { setSelection(ids); if (ids.length) setSelectedSubtitles([]); }} onDropAsset={dropAsset} onMoveClip={moveClip} onTrimClip={trimClip} onBlade={bladeSplit}
        onRemoveTrack={(trackId) => commit((state) => state.clips.some((clip) => clip.trackId === trackId) ? state : { ...state, tracks: state.tracks.filter((track) => track.id !== trackId) })}
        onTrack={(trackId, patch) => commit((state) => ({ ...state, tracks: state.tracks.map((track) => track.id === trackId ? { ...track, ...patch } : track) }))}
        onRemoveMarker={(id) => commit((state) => ({ ...state, markers: state.markers.filter((marker) => marker.id !== id) }))}
        onZoom={(value) => setZoom(clampZoom(value))} onCover={() => setCoverOpen(true)} onViewport={setViewportWidth}
        subtitleMode={subtitleMode} selectedSubtitles={selectedSubtitles}
        onSelectSubtitle={(id, additive) => {
          if (id !== null) setSelection([]);
          if (id !== null && additive) setSelectedSubtitles((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);
          else setSelectedSubtitle(id);
          if (id !== null) setLeftTab("subtitles");
        }}
        onVolume={(clipId, volume) => {
          const clip = project.clips.find((item) => item.id === clipId);
          if (!clip) return;
          // With volume keyframes the whole envelope scales, keeping its shape.
          const ratio = clip.audio.volume > 0 ? volume / clip.audio.volume : 1;
          const volumeKeyframes = clip.audio.volumeKeyframes?.map((point) => ({ ...point, value: Math.max(0, Math.min(2, point.value * ratio)) }));
          commit(updateClip(project, clipId, { audio: { ...clip.audio, volume, volumeKeyframes } }, options));
        }}
        onAddSubtitle={(time) => {
          const id = Math.max(0, ...project.subtitles.map((item) => item.id)) + 1;
          const start = Math.max(0, time);
          const next = project.subtitles.filter((item) => item.start > start).sort((a, b) => a.start - b.start)[0];
          setSubtitles([...project.subtitles, { id, start, end: Math.min(start + 2, next ? next.start : start + 2), zh: "", en: "" }].sort((a, b) => a.start - b.start));
          setSelectedSubtitle(id);
          return id;
        }}
        onSubtitleChange={(id, patch) => setSubtitles(project.subtitles.map((item) => item.id === id ? { ...item, ...patch } : item).sort((a, b) => a.start - b.start))} />
    </section>

    {typeof recording === "number" && <div className="countdown-overlay"><span>{recording}</span><small>{t("即将开始录音")}</small></div>}

    {cropClip && cropAsset && <CropModal clip={cropClip} asset={cropAsset} onClose={() => setCropOpen(false)} onApply={(crop) => { commit((state) => updateClip(state, cropClip.id, { crop }, options)); setCropOpen(false); }} />}

    {coverOpen && <CoverEditor design={cover} ratio={ratio} duration={duration} initialTime={current} frameAt={coverFrameAt} onChange={setCover}
      onApply={(png) => { setCoverImage(cover.layers.length ? png : ""); }} onClose={() => setCoverOpen(false)} />}

    {exportOpen && <div className="modal-backdrop export-backdrop" onMouseDown={() => !exporting && setExportOpen(false)}><section className="export-modal" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span className="eyebrow">EXPORT</span><h2>{t("导出")}</h2></div><button onClick={() => !exporting && setExportOpen(false)}>×</button></header>
      {exporting || exportResult ? <div className="export-progress"><div className="progress-ring" style={{ "--progress": `${progress * 3.6}deg` } as React.CSSProperties}><span>{progress}%</span></div><h3>{exportResult ? t("导出完成") : t("正在渲染视频")}</h3><p>{exportResult ? (exportResult.subtitleFiles.length ? t("已生成 {format}、中文 SRT 和英文 SRT", { format: t(formatLabels[exportFormat]) }) : t("已生成 {format}", { format: t(formatLabels[exportFormat]) })) : progressStage}</p>{exportResult && <div className="export-complete-actions"><button className="primary" onClick={() => window.dashCutDesktop?.revealExport(exportResult.outputPath)}>{t("打开文件位置")}</button><button className="ghost-action" onClick={() => { setExportResult(null); setProgress(0); }}>{t("继续导出")}</button></div>}</div> : <div className="export-form">
        <div className="export-presets">{exportPresets.map((preset) => {
          const active = preset.format === exportFormat && (preset.format !== "mp4" || (preset.codec === exportCodec && preset.resolution === exportResolution && preset.fps === exportFps && preset.ratio === ratio));
          return <button key={preset.id} className={active ? "active" : ""} onClick={() => applyExportPreset(preset)}><b>{t(preset.label)}</b><small>{t(preset.note)}</small></button>;
        })}</div>
        <div className="export-grid">
          <label>{t("格式")}<select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as CompositionOutput["format"])}>{(Object.keys(formatLabels) as Array<CompositionOutput["format"]>).map((format) => <option key={format} value={format}>{t(formatLabels[format])}</option>)}</select></label>
          {(exportFormat === "mp4" || exportFormat === "mov") && <label>{t("编码")}<div className="segmented"><button className={exportCodec === "h264" ? "active" : ""} onClick={() => setExportCodec("h264")}>{t("H.264 兼容")}</button><button className={exportCodec === "hevc" ? "active" : ""} onClick={() => setExportCodec("hevc")}>{t("HEVC 小体积")}</button></div></label>}
          {(exportFormat === "mp4" || exportFormat === "mov") && <label>{t("分辨率")}<select value={exportResolution} onChange={(event) => setExportResolution(Number(event.target.value) as 720 | 1080 | 2160)}><option value="1080">1080P</option><option value="2160">4K</option><option value="720">720P</option></select></label>}
          {(exportFormat === "mp4" || exportFormat === "mov") && <label>{t("帧率")}<div className="segmented"><button className={exportFps === 30 ? "active" : ""} onClick={() => setExportFps(30)}>30 FPS</button><button className={exportFps === 60 ? "active" : ""} onClick={() => setExportFps(60)}>60 FPS</button></div></label>}
          {exportFormat !== "gif" && <label>{t("响度标准化")}<select value={loudnessTarget === null ? "off" : String(loudnessTarget)} onChange={(event) => setLoudnessTarget(event.target.value === "off" ? null : Number(event.target.value))}><option value="-14">{t("-14 LUFS · YouTube / B 站")}</option><option value="-16">{t("-16 LUFS · 播客 / 移动端")}</option><option value="-23">{t("-23 LUFS · 广播 EBU R128")}</option><option value="off">{t("关闭")}</option></select></label>}
        </div>
        <div className="export-summary"><span>{t("时长")}</span><strong>{formatClock(exportFormat === "gif" ? Math.min(15, duration) : duration)}</strong><i></i><span>{t("画布")}</span><strong>{ratio} · {t("{count} 视频轨", { count: project.tracks.filter((track) => track.kind === "video").length })}</strong></div>
        <button className="ghost-action health-button" onClick={() => setHealthOpen(true)}>{t("先做发布前检查")}</button>
        <button className="primary full large" onClick={() => void startExport()}>{t("开始导出 {format}", { format: t(formatLabels[exportFormat]) })}{exportFormat === "mp4" || exportFormat === "mov" ? ` · ${exportFps} FPS` : ""}</button>
      </div>}
    </section></div>}

    {hardwareOpen && <div className="modal-backdrop" onMouseDown={() => setHardwareOpen(false)}><section className="hardware-modal" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span className="eyebrow">LOCAL AI CHECK</span><h2>{t("本地字幕硬件检测")}</h2></div><button onClick={() => setHardwareOpen(false)}>×</button></header>
      {!window.dashCutDesktop ? <div className="hardware-empty"><b>{t("请在 DashCut 极剪桌面版中运行检测")}</b><p>{t("浏览器无法读取完整的 CPU、GPU、内存和磁盘信息。本地 faster-whisper 只在 Windows / macOS 桌面应用中提供。")}</p></div> : checkingHardware ? <div className="hardware-empty"><b>{t("正在检查设备…")}</b><p>{t("检测 CPU、CUDA GPU、系统内存、磁盘和内置 AI 运行时。")}</p></div> : hardware && <div className="hardware-content">
        <div className={`hardware-verdict ${hardware.assessment.tier}`}><span>{hardware.assessment.tier === "recommended" ? "✓" : hardware.assessment.tier === "minimum" ? "!" : "×"}</span><div><b>{hardware.assessment.tier === "recommended" ? t("达到推荐配置") : hardware.assessment.tier === "minimum" ? t("达到最低配置") : t("暂不适合本地识别")}</b><small>{hardware.assessment.tier === "unsupported" ? t("建议使用云端模型") : t("建议 {model} · {computeType}", { model: hardware.assessment.model, computeType: hardware.assessment.computeType })}</small></div></div>
        <div className="hardware-grid"><div><span>CPU</span><b>{hardware.cpu.model}</b><small>{t("{count} 个逻辑核心", { count: hardware.cpu.logicalCores })}</small></div><div><span>{t("系统内存")}</span><b>{hardware.memory.totalGb} GB</b><small>{t("当前可用 {size} GB", { size: hardware.memory.freeGb })}</small></div><div><span>{t("图形处理器")}</span><b>{hardware.gpus[0]?.name || t("未检测到独立 GPU")}</b><small>{hardware.gpus[0]?.fasterWhisperAcceleration ? t("{size} GB VRAM · CUDA", { size: hardware.gpus[0].memoryGb ?? t("未知") }) : t("faster-whisper 将使用 CPU")}</small></div><div><span>{t("可用磁盘")}</span><b>{hardware.diskFreeGb} GB</b><small>{t("建议预留至少 10 GB")}</small></div></div>
        <div className="runtime-status"><strong>{t("内置运行时")}</strong><span className={hardware.runtime?.ready ? "ready" : ""}>{hardware.runtime?.ready ? t("{source} · faster-whisper {version}", { source: hardware.runtime.kind === "bundled" ? t("随安装包提供") : t("开发环境"), version: hardware.runtime.info?.fasterWhisper ?? "" }) : t("不可用，请重新安装 DashCut 极剪")}</span></div>
        {!!hardware.assessment.blockers.length && <div className="hardware-messages blockers"><b>{t("需要解决")}</b>{hardware.assessment.blockers.map((item) => <span key={item}>• {item}</span>)}</div>}
        {!!hardware.assessment.notes.length && <div className="hardware-messages"><b>{t("检测说明")}</b>{hardware.assessment.notes.map((item) => <span key={item}>• {item}</span>)}</div>}
        <div className="requirements-table"><div><b>{t("最低配置")}</b><span>{t("4 核 CPU")}</span><span>8 GB RAM</span><span>{t("4 GB 空间")}</span><small>small · CPU INT8</small></div><div><b>{t("推荐配置")}</b><span>{t("8 核 CPU")}</span><span>16 GB RAM</span><span>{t("8 GB 显存 CUDA GPU")}</span><small>large-v3 · CUDA FP16</small></div></div>
        <section className="model-manager"><header><div><b>{t("选择推理模型")}</b><small>{t("默认不下载，仅在你点击后安装")}</small></div><span>{t("推荐：{model}", { model: hardware.assessment.model })}</span></header><div className="model-list">{localModels.map((model) => <button key={model.id} className={`${selectedModel === model.id ? "selected" : ""} ${model.id === hardware.assessment.model ? "recommended" : ""}`} onClick={() => setSelectedModel(model.id)}><span className="model-radio">{selectedModel === model.id ? "●" : "○"}</span><div><b>{model.label} {model.id === hardware.assessment.model && <i>{t("推荐")}</i>}</b><small>{t("{description} · 约 {size} GB", { description: model.description, size: model.approximateGb })}</small></div>{model.installed ? <span className="model-installed">{t("已安装")}</span> : <span className="model-not-installed">{t("未下载")}</span>}</button>)}</div>
          {localModels.find((model) => model.id === selectedModel)?.installed ? <div className="model-action-row"><span>{t("模型已就绪，可离线使用")}</span><button onClick={() => void removeLocalModel(selectedModel)}>{t("删除模型")}</button></div> : <button className="primary full" disabled={Boolean(installingModel) || hardware.assessment.tier === "unsupported" || !hardware.runtime?.ready} onClick={() => void installLocalModel(selectedModel)}>{installingModel === selectedModel ? t("正在下载安装 {model}…", { model: selectedModel }) : t("下载安装 {model} · 约 {size} GB", { model: selectedModel, size: localModels.find((model) => model.id === selectedModel)?.approximateGb ?? "-" })}</button>}
        </section>
        <div className="hardware-actions"><button className="ghost-action" onClick={() => void checkHardware()}>{t("重新检测")}</button><button className="primary" disabled={hardware.assessment.tier === "unsupported" || !localModels.find((model) => model.id === selectedModel)?.installed} onClick={() => { setRecognitionEngine("local"); setHardwareOpen(false); setToast(t("已选择本地 {model} 模型", { model: selectedModel })); }}>{t("使用本地模型")}</button></div>
      </div>}
    </section></div>}

    {aboutOpen && <div className="modal-backdrop" onMouseDown={() => setAboutOpen(false)}><section className="about-modal" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span className="eyebrow">ABOUT & LICENSES</span><h2>DashCut 极剪</h2></div><button onClick={() => setAboutOpen(false)}>×</button></header>
      <div className="about-content"><p>{t("面向哔哩哔哩与 YouTube 创作者的视频编辑器。")}</p><div><strong>{t("视频运行时")}</strong><span>FFmpeg 9.0.1 · LGPLv2.1-or-later</span><small>{t("macOS 使用 VideoToolbox，Windows 使用 MediaFoundation。安装包包含许可证、源码地址和实际构建参数。")}</small></div><div><strong>{t("应用许可证")}</strong><span>DashCut · MIT License</span></div><a href="https://github.com/Mikasathebest/DashCut/blob/main/THIRD_PARTY_NOTICES.md" target="_blank" rel="noreferrer">{t("查看第三方声明与对应源码")} ↗</a></div>
    </section></div>}

    {recoveries.length > 0 && <div className="modal-backdrop"><section className="about-modal recovery-modal">
      <header><div><span className="eyebrow">RECOVERY</span><h2>{t("发现未保存的项目")}</h2></div></header>
      <div className="about-content"><p>{t("DashCut 上次没有正常关闭，以下项目有自动保存的修改：")}</p>
        {recoveries.map((item) => <div key={item.id} className="recovery-row"><div><strong>{item.title}</strong><small>{new Date(item.savedAt).toLocaleString("zh-CN")}{item.projectPath ? ` · ${item.projectPath}` : ` · ${t("尚未保存到磁盘")}`}</small></div><button className="primary" onClick={() => void restoreRecovery(item)}>{t("恢复")}</button></div>)}
        <button className="ghost-action" onClick={() => void discardRecoveries()}>{t("全部丢弃")}</button>
      </div>
    </section></div>}

    {missingAssets.length > 0 && <div className="modal-backdrop"><section className="about-modal recovery-modal">
      <header><div><span className="eyebrow">RELINK MEDIA</span><h2>{t("找不到 {count} 个素材", { count: missingAssets.length })}</h2></div><button onClick={() => setMissingAssets([])}>×</button></header>
      <div className="about-content"><p>{t("素材可能被移动或重命名。定位其中一个文件后，同一文件夹里同名的其他素材会自动重新链接。")}</p>
        {missingAssets.map((id) => assetMap.get(id)).filter(Boolean).map((asset) => <div key={asset!.id} className="recovery-row"><div><strong>{asset!.name}</strong><small>{asset!.sourcePath || t("无路径")}</small></div><button className="primary" onClick={() => void relinkAsset(asset!.id)}>{t("定位…")}</button></div>)}
        <button className="ghost-action" onClick={() => setMissingAssets([])}>{t("稍后处理")}</button>
      </div>
    </section></div>}

    {translateOpen && <TranslateModal running={translating} stage={captionProgress ? `${captionProgress.stage} ${Math.round(captionProgress.progress * 100)}%` : separating ?? ""} captionCount={project.subtitles.length} separationAvailable={separationReady.runtime}
      onRun={(request) => void runTranslation(request)} onCaptions={() => { setTranslateOpen(false); setLeftTab("subtitles"); }} onClose={() => setTranslateOpen(false)} />}
    {healthOpen && <HealthCheck running={health.running} stage={progressStage} issues={health.issues} onRun={() => void runHealthCheck()} onFix={fixHealthIssue} onSeek={(time) => { seek(time); setHealthOpen(false); setExportOpen(false); }} onClose={() => setHealthOpen(false)} />}

    {reframeOpen && <div className="modal-backdrop" onMouseDown={() => setReframeOpen(false)}><section className="about-modal reframe-modal" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span className="eyebrow">SMART REFRAME</span><h2>{t("智能转竖屏")}</h2></div><button onClick={() => setReframeOpen(false)}>×</button></header>
      <div className="about-content">
        <p>{t("在本机逐帧检测人脸，生成跟随主体的竖屏取景（铺满画面 + 水平位置关键帧）。首次使用会下载约 0.2 MB 的开源人脸检测模型（MediaPipe BlazeFace，Apache-2.0），视频不会上传。")}</p>
        <div className="segmented"><button className={reframeOptions.scope === "main" ? "active" : ""} onClick={() => setReframeOptions({ ...reframeOptions, scope: "main" })}>{t("主轨全部视频")}</button><button className={reframeOptions.scope === "selected" ? "active" : ""} onClick={() => setReframeOptions({ ...reframeOptions, scope: "selected" })}>{t("所选片段（{count}）", { count: selectedClips.length })}</button></div>
        <label className="inspector-slider"><span>{t("跟随速度")}</span><input type="range" min="0" max="1" step="0.05" value={reframeOptions.tracking} onChange={(event) => setReframeOptions({ ...reframeOptions, tracking: Number(event.target.value) })} /><b>{reframeOptions.tracking < 0.34 ? t("平稳") : reframeOptions.tracking < 0.67 ? t("适中") : t("灵敏")}</b><i /></label>
        <label className="inspector-toggle"><input type="checkbox" checked={reframeOptions.switchCanvas} onChange={(event) => setReframeOptions({ ...reframeOptions, switchCanvas: event.target.checked })} />{t("同时把画布改为 9:16 竖屏")}</label>
        <button className="primary" onClick={() => void runReframe()}>{t("开始转换")}</button>
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
  const presets: Array<[string, number | null]> = [[t("自由"), null], [t("原始"), aspect], ["16:9", 16 / 9], ["9:16", 9 / 16], ["1:1", 1], ["4:3", 4 / 3]];
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
    <header><div><span className="eyebrow">CROP</span><h2>{t("裁剪画面")}</h2></div><button onClick={onClose}>×</button></header>
    <div className="crop-stage"><div ref={boxRef} className="crop-box" style={{ aspectRatio: `${asset.width} / ${asset.height}`, backgroundImage: `url("${asset.thumbnail}")` }}>
      <div className="crop-rect" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }} onPointerDown={begin("move")}>
        {["tl", "tr", "bl", "br", "t", "b", "l", "r"].map((handle) => <i key={handle} className={`crop-handle ${handle}`} onPointerDown={begin(handle)} />)}
      </div>
    </div></div>
    <footer><div className="crop-presets">{presets.map(([label, value]) => <button key={label} onClick={() => applyPreset(value)}>{label}</button>)}</div><div><button className="ghost-action" onClick={() => setCrop({ x: 0, y: 0, w: 1, h: 1 })}>{t("重置")}</button><button className="primary" onClick={() => onApply(crop)}>{t("应用裁剪")}</button></div></footer>
  </section></div>;
}
