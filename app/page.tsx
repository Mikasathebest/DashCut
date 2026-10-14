"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

type MediaKind = "video" | "image" | "gif";
type MediaClip = { id: number; name: string; kind: MediaKind; url: string; sourcePath: string; duration: number; color: string; isDemo?: boolean };
type Segment = { id: number; clipId: number; sourceStart: number; sourceEnd: number };
type TimelineSegment = Segment & { timelineStart: number; timelineEnd: number; clip: MediaClip };
type Subtitle = { id: number; start: number; end: number; zh: string; en: string };
type Panel = "media" | "audio" | "text" | "subtitles" | "cover" | "effects";
type RecognitionEngine = "cloud" | "local";
type SubtitleStyle = {
  fontFamily: string;
  fontSize: number;
  color: string;
  outlineColor: string;
  outlineWidth: number;
  backgroundOpacity: number;
};

const clipColors = ["#5c82ff", "#78a1ff", "#6d8df5", "#86a8ff", "#6fc2b5", "#a47ce9"];
const defaultImageDuration = 3;
const mediaKindLabels: Record<MediaKind, string> = { video: "本地视频", image: "图片", gif: "动图" };

const defaultSubtitleStyle: SubtitleStyle = {
  fontFamily: 'Arial, "PingFang SC", "Microsoft YaHei", sans-serif',
  fontSize: 34,
  color: "#ffffff",
  outlineColor: "#111111",
  outlineWidth: 2,
  backgroundOpacity: 35,
};

const panelLabels: Record<Panel, string> = {
  media: "媒体", audio: "音频", text: "文本", subtitles: "字幕", cover: "封面", effects: "特效",
};

function formatTime(value: number) {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  const min = Math.floor(safe / 60);
  const sec = Math.floor(safe % 60);
  const frames = Math.floor((safe % 1) * 30);
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
}

function readVideoDuration(file: File) {
  return new Promise<number>((resolve) => {
    const url = URL.createObjectURL(file);
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.onloadedmetadata = () => {
      const value = Number.isFinite(probe.duration) ? probe.duration : 0;
      URL.revokeObjectURL(url);
      resolve(value);
    };
    probe.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(0);
    };
    probe.src = url;
  });
}

function readImageSize(url: string) {
  return new Promise<boolean>((resolve) => {
    const probe = new Image();
    probe.onload = () => resolve(probe.naturalWidth > 0 && probe.naturalHeight > 0);
    probe.onerror = () => resolve(false);
    probe.src = url;
  });
}

// Sums GIF frame delays by walking the block structure; returns frame count and loop length in seconds.
function readGifTiming(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let frames = 0;
  let seconds = 0;
  if (bytes.length < 13 || String.fromCharCode(bytes[0], bytes[1], bytes[2]) !== "GIF") return { frames, seconds };
  let offset = 13;
  if (bytes[10] & 0x80) offset += 3 * 2 ** ((bytes[10] & 0x07) + 1);
  const skipSubBlocks = () => {
    while (offset < bytes.length && bytes[offset]) offset += bytes[offset] + 1;
    offset += 1;
  };
  while (offset < bytes.length) {
    const block = bytes[offset];
    if (block === 0x21) {
      if (bytes[offset + 1] === 0xf9) seconds += (bytes[offset + 4] | (bytes[offset + 5] << 8) || 10) / 100;
      offset += 2;
      skipSubBlocks();
    } else if (block === 0x2c) {
      const packed = bytes[offset + 9];
      offset += 10;
      if (packed & 0x80) offset += 3 * 2 ** ((packed & 0x07) + 1);
      offset += 1;
      skipSubBlocks();
      frames += 1;
    } else break;
  }
  return { frames, seconds };
}

async function readMediaInfo(file: File, url: string): Promise<{ kind: MediaKind; duration: number }> {
  if (!file.type.startsWith("image/")) return { kind: "video", duration: await readVideoDuration(file) };
  if (!(await readImageSize(url))) return { kind: "image", duration: 0 };
  if (file.type === "image/gif") {
    const { frames, seconds } = readGifTiming(await file.arrayBuffer());
    // Repeat short animations whole so the loop does not jump mid-cycle.
    if (frames > 1 && seconds > 0) return { kind: "gif", duration: seconds * Math.max(1, Math.ceil(defaultImageDuration / seconds)) };
  }
  return { kind: "image", duration: defaultImageDuration };
}

export default function Home() {
  const [panel, setPanel] = useState<Panel>("subtitles");
  const [clips, setClips] = useState<MediaClip[]>([]);
  const [musicName, setMusicName] = useState("");
  const [musicPath, setMusicPath] = useState("");
  const [musicVolume, setMusicVolume] = useState(0.35);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [ratio, setRatio] = useState("16:9");
  const [subtitleMode, setSubtitleMode] = useState<"zh" | "en" | "both">("both");
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [selectedSegment, setSelectedSegment] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [coverOpen, setCoverOpen] = useState(false);
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
  const videoRef = useRef<HTMLVideoElement>(null);
  const currentRef = useRef(0);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const musicInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const timelineSegments = useMemo<TimelineSegment[]>(() => {
    return segments.reduce<TimelineSegment[]>((items, segment) => {
      const clip = clips.find((item) => item.id === segment.clipId);
      if (!clip) return items;
      const cursor = items.at(-1)?.timelineEnd ?? 0;
      const item = { ...segment, timelineStart: cursor, timelineEnd: cursor + segment.sourceEnd - segment.sourceStart, clip };
      return [...items, item];
    }, []);
  }, [clips, segments]);
  const duration = timelineSegments.at(-1)?.timelineEnd ?? 0;
  const activeTimelineSegment = useMemo(
    () => timelineSegments.find((segment) => current >= segment.timelineStart && current < segment.timelineEnd) ?? timelineSegments.at(-1),
    [current, timelineSegments],
  );
  const activeIsVideo = activeTimelineSegment?.clip.kind === "video";
  const videoUrl = activeIsVideo ? activeTimelineSegment.clip.url : "";
  const selectedTimelineSegment = timelineSegments.find((segment) => segment.id === selectedSegment);

  const activeSubtitle = useMemo(
    () => subtitles.find((item) => current >= item.start && current < item.end),
    [current, subtitles],
  );

  useEffect(() => {
    if (!videoUrl || !videoRef.current || !activeTimelineSegment) return;
    const localTime = activeTimelineSegment.sourceStart + current - activeTimelineSegment.timelineStart;
    if (Math.abs(videoRef.current.currentTime - localTime) > 0.35) videoRef.current.currentTime = localTime;
    if (playing) videoRef.current.play().catch(() => setPlaying(false));
    else videoRef.current.pause();
  }, [activeTimelineSegment, current, playing, videoUrl]);

  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  // Images have no media clock, so advance the playhead with animation frames.
  useEffect(() => {
    const segment = activeTimelineSegment;
    if (!playing || !segment || segment.clip.kind === "video") return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = Math.min(segment.timelineEnd, currentRef.current + (now - last) / 1000);
      last = now;
      currentRef.current = next;
      setCurrent(next);
      if (next >= segment.timelineEnd && segment.timelineEnd >= duration) {
        setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [activeTimelineSegment, duration, playing]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(""), 2400);
    return () => window.clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    if (!window.dashCutDesktop) return;
    return window.dashCutDesktop.onExportProgress(({ progress: nextProgress, stage }) => {
      setProgress(nextProgress);
      setProgressStage(stage);
    });
  }, []);

  async function importMedia(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    event.target.value = "";
    const baseId = Math.max(0, ...clips.filter((clip) => !clip.isDemo).map((clip) => clip.id));
    const imported = await Promise.all(files.map(async (file, index): Promise<MediaClip> => {
      const url = URL.createObjectURL(file);
      const info = await readMediaInfo(file, url);
      return {
        id: baseId + index + 1,
        name: file.name,
        kind: info.kind,
        url,
        sourcePath: window.dashCutDesktop?.getFilePath(file) ?? "",
        duration: info.duration,
        color: clipColors[(baseId + index) % clipColors.length],
      };
    }));
    const valid = imported.filter((clip) => clip.duration > 0);
    imported.filter((clip) => clip.duration <= 0).forEach((clip) => URL.revokeObjectURL(clip.url));
    if (!valid.length) return setToast("无法读取所选素材");
    const nextClips = [...clips, ...valid];
    const nextSegments = valid.map((clip) => ({ id: clip.id * 1000, clipId: clip.id, sourceStart: 0, sourceEnd: clip.duration }));
    setClips(nextClips);
    setSegments((items) => [...items, ...nextSegments]);
    setSelectedSegment(nextSegments[0].id);
    setCurrent(0);
    setPlaying(false);
    const counts = (["video", "image", "gif"] as const).map((kind) => [kind, valid.filter((clip) => clip.kind === kind).length] as const).filter(([, count]) => count);
    const skipped = imported.length - valid.length;
    setToast(`已导入 ${counts.map(([kind, count]) => `${count} 个${kind === "video" ? "视频" : mediaKindLabels[kind]}`).join("、")}${skipped ? `，${skipped} 个文件无法读取` : ""}`);
  }

  function updateImageDuration(value: number) {
    if (isGenerating) return setToast("请等待字幕生成完成后再编辑时间线");
    const target = selectedTimelineSegment;
    if (!target || target.clip.kind === "video") return;
    if (!Number.isFinite(value) || value < 0.5 || value > 600) return setToast("图片时长需在 0.5 到 600 秒之间");
    const delta = value - (target.sourceEnd - target.sourceStart);
    if (!delta) return;
    setSegments((items) => items.map((segment) => segment.id === target.id ? { ...segment, sourceEnd: segment.sourceStart + value } : segment));
    // Keep later captions attached to their audio after the timeline shifts.
    setSubtitles((items) => items.map((item) => item.start >= target.timelineEnd - 0.001 ? { ...item, start: item.start + delta, end: item.end + delta } : item));
    if (current > target.timelineStart + value) setCurrent(target.timelineStart + value);
  }

  function importMusic(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setMusicName(file.name.replace(/\.[^.]+$/, ""));
    setMusicPath(window.dashCutDesktop?.getFilePath(file) ?? "");
    setPanel("audio");
    setToast("背景音乐已添加");
  }

  function splitClip() {
    if (isGenerating) return setToast("请等待字幕生成完成后再编辑时间线");
    const targetLayout = timelineSegments.find((segment) => current > segment.timelineStart + 0.3 && current < segment.timelineEnd - 0.3);
    const index = targetLayout ? segments.findIndex((segment) => segment.id === targetLayout.id) : -1;
    if (index === -1) {
      setToast("请把播放头移到片段中间");
      return;
    }
    const target = segments[index];
    const nextId = Math.max(...segments.map((segment) => segment.id)) + 1;
    const sourceTime = target.sourceStart + current - targetLayout!.timelineStart;
    const replacement = [
      { ...target, sourceEnd: sourceTime },
      { id: nextId, clipId: target.clipId, sourceStart: sourceTime, sourceEnd: target.sourceEnd },
    ];
    setSegments([...segments.slice(0, index), ...replacement, ...segments.slice(index + 1)]);
    setSelectedSegment(nextId);
    setToast(`已在 ${formatTime(current)} 分割`);
  }

  function removeClip() {
    if (isGenerating) return setToast("请等待字幕生成完成后再编辑时间线");
    if (segments.length <= 1) return setToast("至少保留一个片段");
    const selected = timelineSegments.find((segment) => segment.id === selectedSegment);
    setSegments(segments.filter((segment) => segment.id !== selectedSegment));
    setSubtitles([]);
    setSelectedSegment(segments.find((segment) => segment.id !== selectedSegment)?.id ?? 1);
    setToast(selected ? `已移除 ${formatTime(selected.timelineStart)} 的片段，请重新生成字幕` : "片段已移除，请重新生成字幕");
  }

  function seekFromPointer(event: React.PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const next = Math.max(0, Math.min(duration, ((event.clientX - rect.left) / rect.width) * duration));
    setCurrent(next);
    const target = timelineSegments.find((segment) => next >= segment.timelineStart && next < segment.timelineEnd) ?? timelineSegments.at(-1);
    if (videoRef.current && target) videoRef.current.currentTime = target.sourceStart + next - target.timelineStart;
  }

  async function generateSubtitles() {
    if (isGenerating) return;
    if (recognitionEngine === "cloud" || autoTranslate) {
      if (!window.dashCutDesktop) return setToast("AI API 字幕仅支持桌面版");
      if (!hubConfig.apiKey.trim()) return setToast("请先填写 AI API API Key，或关闭云端翻译以离线识别");
    }
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
      const sourceClips = clips.filter((clip) => clip.kind === "video" && !clip.isDemo && clip.sourcePath && timelineSegments.some((segment) => segment.clipId === clip.id));
      if (!sourceClips.length) return setToast("时间线中没有含人声的视频，图片和动图无需识别");
      setIsGenerating(true);
      try {
        const useCuda = Boolean(hardware.gpus.some((gpu) => gpu.fasterWhisperAcceleration) && Number(hardware.runtime.info?.cudaDeviceCount) > 0);
        const response = await window.dashCutDesktop.transcribeLocal({
          clips: sourceClips.map((clip) => ({ id: clip.id, path: clip.sourcePath })),
          model: selectedModel,
          device: useCuda ? "cuda" : "cpu",
          computeType: hardware.assessment.computeType,
        });
        let nextId = 1;
        const generated: Subtitle[] = [];
        for (const result of response.results) {
          for (const timeline of timelineSegments.filter((segment) => segment.clipId === result.clipId)) {
            for (const caption of result.segments) {
              const sourceStart = Math.max(caption.start, timeline.sourceStart);
              const sourceEnd = Math.min(caption.end, timeline.sourceEnd);
              if (sourceEnd <= sourceStart) continue;
              // Clip word timestamps at cuts instead of repeating the full utterance.
              const text = caption.words?.length ? caption.words.filter((word) => (word.start + word.end) / 2 >= sourceStart && (word.start + word.end) / 2 < sourceEnd).map((word) => word.word).join("").trim() : caption.text;
              if (!text) continue;
              const isChinese = /[\u3400-\u9fff]/u.test(text);
              generated.push({
                id: nextId++,
                start: timeline.timelineStart + sourceStart - timeline.sourceStart,
                end: timeline.timelineStart + sourceEnd - timeline.sourceStart,
                zh: isChinese ? text : "",
                en: isChinese ? "" : text,
              });
            }
          }
        }
        generated.sort((a, b) => a.start - b.start);
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
    const sourceClips = clips.filter((clip) => clip.kind === "video" && !clip.isDemo && clip.sourcePath && timelineSegments.some((segment) => segment.clipId === clip.id));
    if (!sourceClips.length) return setToast("时间线中没有含人声的视频，图片和动图无需识别");
    setIsGenerating(true);
    try {
      const response = await window.dashCutDesktop.transcribeHub({ config: { ...hubConfig, model: hubAudioModel }, clips: sourceClips.map((clip) => ({ id: clip.id, path: clip.sourcePath })) });
      const generated: Subtitle[] = [];
      for (const timeline of timelineSegments) {
        for (const caption of response.results.find((result) => result.clipId === timeline.clipId)?.segments ?? []) {
          const start = Math.max(caption.start, timeline.sourceStart);
          const end = Math.min(caption.end, timeline.sourceEnd);
          if (end <= start) continue;
          generated.push({ id: generated.length + 1, start: timeline.timelineStart + start - timeline.sourceStart, end: timeline.timelineStart + end - timeline.sourceStart, zh: caption.zh, en: caption.en });
        }
      }
      setSubtitles(generated);
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
    if (!window.dashCutDesktop || isGenerating || !subtitles.length) return;
    setIsGenerating(true);
    try {
      setSubtitles(await window.dashCutDesktop.translateSubtitles({ config: hubConfig, subtitles }));
      setToast("中英译文已更新，字幕时间保持不变");
    } catch (error) { setToast(error instanceof Error ? error.message : "翻译失败，原字幕已保留"); }
    finally { setIsGenerating(false); }
  }

  function updateSubtitleTime(id: number, field: "start" | "end", value: number) {
    const subtitle = subtitles.find((item) => item.id === id);
    if (!subtitle || !Number.isFinite(value) || value < 0 || value > duration || (field === "start" ? value >= subtitle.end : value <= subtitle.start)) {
      setToast("字幕时间必须在时间线范围内，结束时间大于开始时间");
      return false;
    }
    setSubtitles((items) => items.map((item) => item.id === id ? { ...item, [field]: value } : item).sort((a, b) => a.start - b.start));
    return true;
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

  function updateSubtitle(id: number, field: "zh" | "en", value: string) {
    setSubtitles((items) => items.map((item) => item.id === id ? { ...item, [field]: value } : item));
  }

  async function startExport() {
    if (!window.dashCutDesktop) return setToast("真实视频导出仅支持桌面版");
    if (!timelineSegments.length) return setToast("请先导入视频或图片");
    setExporting(true);
    setExportResult(null);
    setProgress(0);
    setProgressStage("正在准备导出");
    try {
      const result = await window.dashCutDesktop.exportVideo({
        segments: timelineSegments.map((segment) => ({ path: segment.clip.sourcePath, kind: segment.clip.kind, sourceStart: segment.sourceStart, sourceEnd: segment.sourceEnd })),
        subtitles,
        subtitleStyle,
        musicPath,
        musicVolume,
        fps: exportFps,
        resolution: exportResolution,
        platform,
      });
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

  function renderCover(download = false) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = 1280;
    canvas.height = 720;
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
      const link = document.createElement("a");
      link.href = canvas.toDataURL("image/png");
      link.download = "视频封面.png";
      link.click();
      setToast("封面图已保存");
    }
  }

  useEffect(() => {
    // Canvas drawing is an imperative synchronization with the cover editor.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (coverOpen) renderCover(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coverOpen, coverTitle, coverAccent]);

  const panelContent = {
    media: <>
      <div className="panel-heading"><div><span className="eyebrow">MEDIA</span><h2>项目媒体</h2></div><button className="icon-button">•••</button></div>
      <button className="upload-card" onClick={() => videoInputRef.current?.click()}><span>＋</span><strong>导入视频、图片或动图</strong><small>可混合多选 MP4、MOV、WebM、JPG、PNG、WebP、GIF</small></button>
      <h3 className="section-title">项目素材 · {clips.length}</h3>
      <div className="media-list">{clips.map((clip) => <button className="media-card" key={clip.id} onClick={() => {
        const segment = timelineSegments.find((item) => item.clipId === clip.id);
        if (segment) { setCurrent(segment.timelineStart); setSelectedSegment(segment.id); }
      }}><div className="media-thumb" style={{ background: clip.kind === "video" ? clip.color : `center / cover no-repeat url("${clip.url}")` }}>{clip.kind !== "image" && <span>{clip.kind === "gif" ? "GIF" : "▶"}</span>}</div><div><strong>{clip.name}</strong><small>{formatTime(clip.duration)} · {mediaKindLabels[clip.kind]}</small></div></button>)}</div>
      {selectedTimelineSegment && selectedTimelineSegment.clip.kind !== "video" && <label className="range-label image-duration"><span>所选{mediaKindLabels[selectedTimelineSegment.clip.kind]}时长（秒）</span><input key={`${selectedTimelineSegment.id}-${selectedTimelineSegment.sourceEnd}`} type="number" min="0.5" max="600" step="0.5" defaultValue={(selectedTimelineSegment.sourceEnd - selectedTimelineSegment.sourceStart).toFixed(1)} disabled={isGenerating} onBlur={(event) => updateImageDuration(event.currentTarget.valueAsNumber)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>}
      {!clips.length && <p className="empty-hint">尚未导入素材。可同时选择视频、图片和动图，按选择顺序加入时间线；图片默认 {defaultImageDuration} 秒。</p>}
    </>,
    audio: <>
      <div className="panel-heading"><div><span className="eyebrow">AUDIO</span><h2>背景音乐</h2></div><button className="icon-button">＋</button></div>
      <button className="upload-card audio-upload" onClick={() => musicInputRef.current?.click()}><span>♫</span><strong>添加音乐或音效</strong><small>支持 MP3、WAV、M4A</small></button>
      <h3 className="section-title">已添加</h3>
      {musicName ? <div className="song-card"><button>▶</button><div><strong>{musicName}</strong><small>背景音乐</small></div><span>•••</span></div> : <p className="empty-hint">尚未添加背景音乐</p>}
      <label className="range-label"><span>音乐音量</span><b>{Math.round(musicVolume * 100)}%</b></label><input className="range" type="range" min="0" max="100" value={Math.round(musicVolume * 100)} onChange={(event) => setMusicVolume(Number(event.target.value) / 100)} />
      <p className="empty-hint">导出时会将背景音乐与原视频声音真实混合。</p>
    </>,
    text: <>
      <div className="panel-heading"><div><span className="eyebrow">TEXT</span><h2>文字</h2></div></div>
      <div className="text-presets"><button><b>Aa</b><span>标题</span></button><button><b className="outline-type">Aa</b><span>描边</span></button><button><b className="serif-type">Aa</b><span>衬线</span></button><button><b className="neon-type">Aa</b><span>霓虹</span></button></div>
      <button className="primary full">＋ 添加文本</button>
    </>,
    subtitles: <>
      <div className="panel-heading"><div><span className="eyebrow">AI CAPTIONS</span><h2>自动字幕</h2></div><span className="ai-badge">AI</span></div>
      <div className="language-switch"><button className={subtitleMode === "zh" ? "active" : ""} onClick={() => setSubtitleMode("zh")}>中文</button><button className={subtitleMode === "en" ? "active" : ""} onClick={() => setSubtitleMode("en")}>English</button><button className={subtitleMode === "both" ? "active" : ""} onClick={() => setSubtitleMode("both")}>中英双语</button></div>
      <div className="engine-switch"><button className={recognitionEngine === "cloud" ? "active" : ""} onClick={() => setRecognitionEngine("cloud")}><b>☁</b><span>云端模型<small>速度快 · 需要网络</small></span></button><button className={recognitionEngine === "local" ? "active" : ""} onClick={() => { setRecognitionEngine("local"); void checkHardware(); }}><b>⌁</b><span>本地模型<small>离线 · 保护隐私</small></span></button></div>
      <details className="hub-settings" open>
        <summary>AI API · 中英字幕</summary>
        <p>准确同步推荐：本地 Whisper large-v3 + 云端翻译。云端识别时间为估算，可手动校准。</p>
        <label>API base URL<input value={hubConfig.baseUrl} disabled={isGenerating || loadingHubModels} onChange={(event) => { setHubModels([]); setHubConfig({ ...hubConfig, baseUrl: event.target.value }); }} /></label>
        <label>API Key（仅本次会话）<input type="password" autoComplete="off" value={hubConfig.apiKey} disabled={isGenerating || loadingHubModels} onChange={(event) => setHubConfig({ ...hubConfig, apiKey: event.target.value })} placeholder="输入密钥，不保存到磁盘" /></label>
        <button className="ghost-action" disabled={loadingHubModels || isGenerating} onClick={() => void refreshHubModels()}>{loadingHubModels ? "正在查询…" : `查询可用模型${hubModels.length ? ` (${hubModels.length})` : ""}`}</button>
        {recognitionEngine === "cloud" ? <label>音频识别模型<select value={hubAudioModel} disabled={isGenerating} onChange={(event) => setHubAudioModel(event.target.value)}><option value="us/gcp/google/gemini-2.5-flash">Gemini 2.5 Flash · 已测试音频</option><option value="us/gcp/google/gemini-3.5-flash">Gemini 3.5 Flash · 已测试音频</option></select></label> : <label className="hub-checkbox"><input type="checkbox" checked={autoTranslate} disabled={isGenerating} onChange={(event) => setAutoTranslate(event.target.checked)} />识别后自动生成中英译文</label>}
        <label>翻译模型<input list="hub-models" value={hubConfig.model} disabled={isGenerating} onChange={(event) => setHubConfig({ ...hubConfig, model: event.target.value })} /><datalist id="hub-models">{hubModels.filter((model) => model.mode === "chat").map((model) => <option key={model.id} value={model.id} />)}</datalist></label>
        <small>{recognitionEngine === "cloud" ? "生成时会将视频音轨发送到接口。" : autoTranslate ? "生成时仅将识别后的字幕文本发送到接口。" : "关闭自动翻译时，本地识别可离线运行。"}</small>
        <button className="ghost-action" disabled={isGenerating || !subtitles.length} onClick={() => void translateExistingSubtitles()}>翻译当前字幕 · 保留时间戳</button>
      </details>
      <button className="generate-button" onClick={generateSubtitles} disabled={isGenerating}><span>{isGenerating ? "◌" : "✦"}</span><strong>{isGenerating ? "正在识别人声…" : "重新识别字幕"}</strong><small>{isGenerating ? "正在分析音轨与语义" : "普通话 / English · 自动断句"}</small></button>
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
        {subtitles.map((item) => <div className={`subtitle-row ${current >= item.start && current < item.end ? "active" : ""}`} key={item.id} onClick={() => setCurrent(item.start + 0.05)}>
          <time>{formatTime(item.start).slice(0, 5)}</time><div>
            {subtitleMode !== "en" && <input disabled={isGenerating} value={item.zh} onChange={(event) => updateSubtitle(item.id, "zh", event.target.value)} />}
            {subtitleMode !== "zh" && <input disabled={isGenerating} className="translation" value={item.en} onChange={(event) => updateSubtitle(item.id, "en", event.target.value)} />}
            <div className="subtitle-timing" onClick={(event) => event.stopPropagation()}>{(["start", "end"] as const).map((field) => <label key={field}>{field === "start" ? "起" : "止"}<input key={item[field]} aria-label={`${field === "start" ? "开始" : "结束"}时间（秒）`} type="number" min="0" max={duration} step="0.01" defaultValue={item[field].toFixed(2)} disabled={isGenerating} onBlur={(event) => { if (!updateSubtitleTime(item.id, field, event.currentTarget.valueAsNumber)) event.currentTarget.value = item[field].toFixed(2); }} /></label>)}</div>
          </div><button>⋮</button>
        </div>)}
        {!subtitles.length && <p className="empty-hint">导入视频并选择识别模型后生成真实字幕。</p>}
      </div>
    </>,
    cover: <>
      <div className="panel-heading"><div><span className="eyebrow">COVER</span><h2>视频封面</h2></div></div>
      <div className="cover-mini"><span>TRAVEL</span><b>独自旅行的<br/>48 小时</b></div>
      <p className="helper">用当前画面或预设快速制作适合 B 站和 YouTube 的首页图。</p>
      <button className="primary full" onClick={() => setCoverOpen(true)}>打开封面设计器</button>
    </>,
    effects: <>
      <div className="panel-heading"><div><span className="eyebrow">EFFECTS</span><h2>画面效果</h2></div></div>
      <div className="effect-grid"><button><i className="fx warm"></i><span>暖阳</span></button><button><i className="fx film"></i><span>胶片</span></button><button><i className="fx cool"></i><span>清透</span></button><button><i className="fx mono"></i><span>黑白</span></button></div>
    </>,
  };

  return <main className="app-shell">
    <input ref={videoInputRef} className="hidden-input" type="file" accept="video/*,image/*" multiple onChange={importMedia} />
    <input ref={musicInputRef} className="hidden-input" type="file" accept="audio/*" onChange={importMusic} />
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><i></i><i></i></span><strong>DashCut <em>极剪</em></strong></div>
      <div className="project-title"><button>‹</button><div><strong>城市漫游</strong><span>已自动保存 · 刚刚</span></div><button>⌄</button></div>
      <div className="top-actions"><button className="ghost">↶</button><button className="ghost disabled">↷</button><button className="ghost hide-mobile" onClick={() => setAboutOpen(true)}>关于与许可</button><button className="export-button" onClick={() => setExportOpen(true)}>导出视频 <span>↗</span></button><button className="avatar">林</button></div>
    </header>

    <section className="workspace">
      <nav className="tool-rail">
        {(Object.keys(panelLabels) as Panel[]).map((key) => <button key={key} className={panel === key ? "active" : ""} onClick={() => key === "cover" ? setCoverOpen(true) : setPanel(key)}>
          <span className={`tool-icon ${key}`}>{key === "media" ? "▣" : key === "audio" ? "♫" : key === "text" ? "T" : key === "subtitles" ? "字" : key === "cover" ? "▧" : "✦"}</span>{panelLabels[key]}
        </button>)}
      </nav>

      <aside className="side-panel">{panelContent[panel]}</aside>

      <section className="stage">
        <div className="stage-toolbar"><button className="canvas-size">画布 {ratio}⌄</button><span></span><button onClick={() => setRatio(ratio === "16:9" ? "9:16" : "16:9")}>适应画布</button><button>100%⌄</button></div>
        <div className={`video-frame ratio-${ratio.replace(":", "-")}`}>
          {videoUrl ? <video ref={videoRef} key={videoUrl} src={videoUrl} muted={muted} onLoadedMetadata={(event) => {
            if (activeTimelineSegment) event.currentTarget.currentTime = activeTimelineSegment.sourceStart + current - activeTimelineSegment.timelineStart;
          }} onTimeUpdate={(event) => {
            if (!activeTimelineSegment) return;
            const next = activeTimelineSegment.timelineStart + event.currentTarget.currentTime - activeTimelineSegment.sourceStart;
            setCurrent(Math.min(activeTimelineSegment.timelineEnd, Math.max(activeTimelineSegment.timelineStart, next)));
            if (event.currentTarget.currentTime >= activeTimelineSegment.sourceEnd - 0.05) {
              const index = timelineSegments.findIndex((item) => item.id === activeTimelineSegment.id);
              const nextSegment = timelineSegments[index + 1];
              if (nextSegment) setCurrent(nextSegment.timelineStart);
              else setPlaying(false);
            }
          }} onEnded={() => setPlaying(false)} /> : activeTimelineSegment ? <img className="stage-image" key={activeTimelineSegment.clip.url} src={activeTimelineSegment.clip.url} alt={activeTimelineSegment.clip.name} /> : <button className="empty-stage" onClick={() => videoInputRef.current?.click()}><span>＋</span><strong>导入素材开始创作</strong><small>支持一次选择多个视频、图片和动图</small></button>}{/* eslint-disable-line @next/next/no-img-element -- local blob URLs cannot use next/image */}
          <div className="caption-preview" style={{
            color: subtitleStyle.color,
            fontFamily: subtitleStyle.fontFamily,
            fontSize: `${subtitleStyle.fontSize}px`,
            WebkitTextStroke: `${subtitleStyle.outlineWidth}px ${subtitleStyle.outlineColor}`,
            textShadow: `0 2px 6px ${subtitleStyle.outlineColor}`,
            "--caption-bg": `rgba(0,0,0,${subtitleStyle.backgroundOpacity / 100})`,
          } as React.CSSProperties}>
            {subtitleMode !== "en" && <strong>{activeSubtitle?.zh}</strong>}
            {subtitleMode !== "zh" && <span>{activeSubtitle?.en}</span>}
          </div>
          <div className="frame-handle tl"></div><div className="frame-handle tr"></div><div className="frame-handle bl"></div><div className="frame-handle br"></div>
        </div>
        <div className="player-controls"><span>{formatTime(current)}</span><div><button>│‹</button><button className="play" onClick={() => setPlaying(!playing)}>{playing ? "Ⅱ" : "▶"}</button><button>›│</button></div><div><button onClick={() => setMuted(!muted)}>{muted ? "🔇" : "♩"}</button><button>⛶</button></div></div>
      </section>
    </section>

    <section className="timeline-area">
      <div className="timeline-toolbar"><div><button onClick={splitClip}>✂ <span>分割</span></button><button onClick={removeClip}>⌫</button><button>◇</button><button>⤢</button></div><div className="time-readout"><b>{formatTime(current)}</b><span>/ {formatTime(duration)}</span></div><div><button>−</button><input type="range" min="35" max="100" defaultValue="70"/><button>＋</button><button className="fit-button">⇔</button></div></div>
      <div className="timeline-scroll" onPointerDown={seekFromPointer}>
        <div className="track-labels"><span>视频</span><span>音频</span><span>字幕</span></div>
        <div className="tracks">
          <div className="ruler">{Array.from({ length: 13 }).map((_, index) => <span key={index} style={{ left: `${index * 8.333}%` }}>{index * 5}s</span>)}</div>
          <div className="video-track">
            {timelineSegments.map((segment) => <button key={segment.id} className={selectedSegment === segment.id ? "selected" : ""} onClick={(event) => { event.stopPropagation(); setSelectedSegment(segment.id); setCurrent(segment.timelineStart); }} style={{ width: `${((segment.timelineEnd - segment.timelineStart) / Math.max(duration, 1)) * 100}%`, background: segment.clip.color }}><i></i><span>{segment.clip.name.replace(/\.[^.]+$/, "")}</span></button>)}
          </div>
          <div className={`audio-track ${musicName ? "" : "empty"}`}>{musicName ? <><span className="audio-title">♫ {musicName}</span><div className="waveform">{Array.from({ length: 76 }).map((_, index) => <i key={index} style={{ height: `${20 + ((index * 17) % 70)}%` }}></i>)}</div></> : <span className="audio-title">未添加背景音乐</span>}</div>
          <div className="caption-track">{subtitles.map((subtitle) => <button key={subtitle.id} style={{ left: `${(subtitle.start / Math.max(duration, 1)) * 100}%`, width: `${((subtitle.end - subtitle.start) / Math.max(duration, 1)) * 100}%` }}>{subtitle.zh}</button>)}</div>
          <div className="playhead" style={{ left: `${(current / Math.max(duration, 1)) * 100}%` }}><i></i></div>
        </div>
      </div>
    </section>

    {coverOpen && <div className="modal-backdrop" onMouseDown={() => setCoverOpen(false)}><section className="cover-modal" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span className="eyebrow">COVER STUDIO</span><h2>创建首页图</h2></div><button onClick={() => setCoverOpen(false)}>×</button></header>
      <div className="cover-workspace"><div className="canvas-wrap"><canvas ref={canvasRef}></canvas><span>1280 × 720 · 16:9</span></div><aside>
        <label>封面标题<input value={coverTitle} maxLength={24} onChange={(event) => setCoverTitle(event.target.value)} /></label>
        <label>强调色<div className="color-options">{["#ffcc45", "#56e0c7", "#ff7289", "#8ba8ff"].map((color) => <button key={color} className={coverAccent === color ? "active" : ""} style={{ background: color }} onClick={() => setCoverAccent(color)} />)}</div></label>
        <label>平台预览<div className="platform-preview"><button className="active">哔哩哔哩</button><button>YouTube</button></div></label>
        <button className="primary full" onClick={() => renderCover(true)}>保存封面 PNG</button>
      </aside></div>
    </section></div>}

    {exportOpen && <div className="modal-backdrop export-backdrop" onMouseDown={() => !exporting && setExportOpen(false)}><section className="export-modal" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span className="eyebrow">EXPORT</span><h2>导出视频</h2></div><button onClick={() => !exporting && setExportOpen(false)}>×</button></header>
      {exporting || exportResult ? <div className="export-progress"><div className="progress-ring" style={{ "--progress": `${progress * 3.6}deg` } as React.CSSProperties}><span>{progress}%</span></div><h3>{exportResult ? "导出完成" : "正在渲染视频"}</h3><p>{exportResult ? `已生成 MP4、中文 SRT 和英文 SRT` : `${progressStage} · ${exportFps} FPS`}</p>{exportResult && <div className="export-complete-actions"><button className="primary" onClick={() => window.dashCutDesktop?.revealExport(exportResult.outputPath)}>打开文件位置</button><button className="ghost-action" onClick={() => { setExportResult(null); setProgress(0); }}>继续导出</button></div>}</div> : <div className="export-form">
        <label>发布平台<div className="platform-cards"><button className={platform === "bilibili" ? "active bili" : "bili"} onClick={() => setPlatform("bilibili")}><b>哔</b><span>哔哩哔哩<small>1080P · 高码率</small></span><i>✓</i></button><button className={platform === "youtube" ? "active youtube" : "youtube"} onClick={() => setPlatform("youtube")}><b>▶</b><span>YouTube<small>1080P · H.264</small></span><i>✓</i></button></div></label>
        <div className="export-grid"><label>分辨率<select value={exportResolution} onChange={(event) => setExportResolution(Number(event.target.value) as 720 | 1080 | 2160)}><option value="1080">1080P (1920×1080)</option><option value="2160">4K (3840×2160)</option><option value="720">720P (1280×720)</option></select></label><label>帧率<div className="segmented"><button className={exportFps === 30 ? "active" : ""} onClick={() => setExportFps(30)}>30 FPS</button><button className={exportFps === 60 ? "active" : ""} onClick={() => setExportFps(60)}>60 FPS</button></div></label></div>
        <label className="check-row"><input type="checkbox" defaultChecked/><span><strong>内嵌双语字幕</strong><small>中文字幕 + English</small></span></label>
        <div className="export-summary"><span>时间线</span><strong>{formatTime(duration)}</strong><i></i><span>视频片段</span><strong>{timelineSegments.length} 个</strong></div>
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
      <div className="about-content"><p>面向哔哩哔哩与 YouTube 创作者的双语智能视频编辑器。</p><div><strong>视频运行时</strong><span>FFmpeg 9.0.1 · LGPLv2.1-or-later</span><small>macOS 使用 VideoToolbox，Windows 使用 MediaFoundation。安装包包含许可证、源码地址和实际构建参数。</small></div><div><strong>应用许可证</strong><span>DashCut · MIT License</span></div><a href="https://github.com/Mikasathebest/DashCut/blob/main/THIRD_PARTY_NOTICES.md" target="_blank" rel="noreferrer">查看第三方声明与对应源码 ↗</a></div>
    </section></div>}

    {toast && <div className="toast"><span>✓</span>{toast}</div>}
  </main>;
}
