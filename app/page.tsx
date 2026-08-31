"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

type MediaClip = { id: number; name: string; url: string; sourcePath: string; duration: number; color: string; isDemo?: boolean };
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

export default function Home() {
  const [panel, setPanel] = useState<Panel>("subtitles");
  const [clips, setClips] = useState<MediaClip[]>([]);
  const [musicName, setMusicName] = useState("");
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
  const [coverTitle, setCoverTitle] = useState("独自旅行的 48 小时");
  const [coverAccent, setCoverAccent] = useState("#ffcc45");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFps, setExportFps] = useState<30 | 60>(60);
  const [platform, setPlatform] = useState<"bilibili" | "youtube">("bilibili");
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [toast, setToast] = useState("");
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyle>(defaultSubtitleStyle);
  const [styleOpen, setStyleOpen] = useState(false);
  const [recognitionEngine, setRecognitionEngine] = useState<RecognitionEngine>("cloud");
  const [hardwareOpen, setHardwareOpen] = useState(false);
  const [hardware, setHardware] = useState<HardwareProfile | null>(null);
  const [checkingHardware, setCheckingHardware] = useState(false);
  const [localModels, setLocalModels] = useState<LocalModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<LocalModelInfo["id"]>("small");
  const [installingModel, setInstallingModel] = useState<string>("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const musicInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const timelineSegments = useMemo<TimelineSegment[]>(() => {
    let cursor = 0;
    return segments.flatMap((segment) => {
      const clip = clips.find((item) => item.id === segment.clipId);
      if (!clip) return [];
      const item = { ...segment, timelineStart: cursor, timelineEnd: cursor + segment.sourceEnd - segment.sourceStart, clip };
      cursor = item.timelineEnd;
      return [item];
    });
  }, [clips, segments]);
  const duration = timelineSegments.at(-1)?.timelineEnd ?? 0;
  const activeTimelineSegment = useMemo(
    () => timelineSegments.find((segment) => current >= segment.timelineStart && current < segment.timelineEnd) ?? timelineSegments.at(-1),
    [current, timelineSegments],
  );
  const videoUrl = activeTimelineSegment?.clip.url ?? "";

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
    if (!toast) return;
    const id = window.setTimeout(() => setToast(""), 2400);
    return () => window.clearTimeout(id);
  }, [toast]);

  async function importVideo(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    const baseId = Math.max(0, ...clips.filter((clip) => !clip.isDemo).map((clip) => clip.id));
    const imported = await Promise.all(files.map(async (file, index): Promise<MediaClip> => ({
      id: baseId + index + 1,
      name: file.name,
      url: URL.createObjectURL(file),
      sourcePath: window.dashCutDesktop?.getFilePath(file) ?? "",
      duration: await readVideoDuration(file),
      color: clipColors[(baseId + index) % clipColors.length],
    })));
    const valid = imported.filter((clip) => clip.duration > 0);
    if (!valid.length) return setToast("无法读取所选视频");
    const nextClips = [...clips, ...valid];
    const nextSegments = valid.map((clip) => ({ id: clip.id * 1000, clipId: clip.id, sourceStart: 0, sourceEnd: clip.duration }));
    setClips(nextClips);
    setSegments((items) => [...items, ...nextSegments]);
    setSelectedSegment(nextSegments[0].id);
    setCurrent(0);
    setPlaying(false);
    event.target.value = "";
    setToast(`已导入 ${valid.length} 个视频片段`);
  }

  function importMusic(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setMusicName(file.name.replace(/\.[^.]+$/, ""));
    setPanel("audio");
    setToast("背景音乐已添加");
  }

  function splitClip() {
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
    if (segments.length <= 1) return setToast("至少保留一个视频片段");
    const selected = timelineSegments.find((segment) => segment.id === selectedSegment);
    setSegments(segments.filter((segment) => segment.id !== selectedSegment));
    setSelectedSegment(segments.find((segment) => segment.id !== selectedSegment)?.id ?? 1);
    setToast(selected ? `已移除 ${formatTime(selected.timelineStart)} 的片段` : "片段已移除");
  }

  function seekFromPointer(event: React.PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const next = Math.max(0, Math.min(duration, ((event.clientX - rect.left) / rect.width) * duration));
    setCurrent(next);
    const target = timelineSegments.find((segment) => next >= segment.timelineStart && next < segment.timelineEnd) ?? timelineSegments.at(-1);
    if (videoRef.current && target) videoRef.current.currentTime = target.sourceStart + next - target.timelineStart;
  }

  async function generateSubtitles() {
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
      const sourceClips = clips.filter((clip) => !clip.isDemo && clip.sourcePath);
      if (!sourceClips.length) return setToast("请先导入本地视频");
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
              const isChinese = result.language.toLowerCase().startsWith("zh");
              generated.push({
                id: nextId++,
                start: timeline.timelineStart + sourceStart - timeline.sourceStart,
                end: timeline.timelineStart + sourceEnd - timeline.sourceStart,
                zh: isChinese ? caption.text : "",
                en: isChinese ? "" : caption.text,
              });
            }
          }
        }
        generated.sort((a, b) => a.start - b.start);
        setSubtitles(generated);
        setToast(`本地识别完成 · ${response.model} / ${response.device}`);
      } catch (error) {
        setToast(error instanceof Error ? error.message : "本地识别失败");
      } finally {
        setIsGenerating(false);
      }
      return;
    }
    setToast("云端识别服务尚未配置，请选择本地模型");
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

  function startExport() {
    setExporting(true);
    setProgress(8);
    const timer = window.setInterval(() => {
      setProgress((value) => {
        const next = Math.min(100, value + Math.ceil(Math.random() * 13));
        if (next >= 100) {
          window.clearInterval(timer);
          window.setTimeout(() => setExporting(false), 500);
        }
        return next;
      });
    }, 260);
  }

  function downloadProject() {
    const payload = {
      project: "城市漫游",
      platform,
      fps: exportFps,
      ratio,
      clips: clips.map((clip) => ({ id: clip.id, name: clip.name, sourcePath: clip.sourcePath, duration: clip.duration, color: clip.color })),
      segments,
      subtitles,
      subtitleStyle,
      recognitionEngine,
      music: musicName,
    };
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    link.download = "dashcut-project.json";
    link.click();
    URL.revokeObjectURL(link.href);
    setToast("项目配置已保存");
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
      <button className="upload-card" onClick={() => videoInputRef.current?.click()}><span>＋</span><strong>导入多个视频片段</strong><small>可多选 MP4、MOV、WebM</small></button>
      <h3 className="section-title">项目素材 · {clips.length}</h3>
      <div className="media-list">{clips.map((clip) => <button className="media-card" key={clip.id} onClick={() => {
        const segment = timelineSegments.find((item) => item.clipId === clip.id);
        if (segment) { setCurrent(segment.timelineStart); setSelectedSegment(segment.id); }
      }}><div className="media-thumb" style={{ background: clip.color }}><span>▶</span></div><div><strong>{clip.name}</strong><small>{formatTime(clip.duration)} · 本地视频</small></div></button>)}</div>
      {!clips.length && <p className="empty-hint">尚未导入素材。选择多个视频后会按顺序加入时间线。</p>}
    </>,
    audio: <>
      <div className="panel-heading"><div><span className="eyebrow">AUDIO</span><h2>背景音乐</h2></div><button className="icon-button">＋</button></div>
      <button className="upload-card audio-upload" onClick={() => musicInputRef.current?.click()}><span>♫</span><strong>添加音乐或音效</strong><small>支持 MP3、WAV、M4A</small></button>
      <h3 className="section-title">已添加</h3>
      {musicName ? <div className="song-card"><button>▶</button><div><strong>{musicName}</strong><small>背景音乐</small></div><span>•••</span></div> : <p className="empty-hint">尚未添加背景音乐</p>}
      <label className="range-label"><span>音乐音量</span><b>38%</b></label><input className="range" type="range" defaultValue="38" />
      <label className="switch-row"><span><strong>智能避让</strong><small>有人声时自动降低音乐</small></span><input type="checkbox" defaultChecked /></label>
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
      <button className="generate-button" onClick={generateSubtitles} disabled={isGenerating}><span>{isGenerating ? "◌" : "✦"}</span><strong>{isGenerating ? "正在识别人声…" : "重新识别字幕"}</strong><small>{isGenerating ? "正在分析音轨与语义" : "普通话 / English · 自动断句"}</small></button>
      <div className="recognition-meta"><span><i></i> {recognitionEngine === "cloud" ? "云端模式 · 待配置接口" : hardware?.assessment.tier === "recommended" ? "本地模式 · 推荐配置" : "本地模式 · 需要检测"}</span><button onClick={() => setStyleOpen(!styleOpen)}>字幕样式 {styleOpen ? "⌃" : "⌄"}</button></div>
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
            {subtitleMode !== "en" && <input value={item.zh} onChange={(event) => updateSubtitle(item.id, "zh", event.target.value)} />}
            {subtitleMode !== "zh" && <input className="translation" value={item.en} onChange={(event) => updateSubtitle(item.id, "en", event.target.value)} />}
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
    <input ref={videoInputRef} className="hidden-input" type="file" accept="video/*" multiple onChange={importVideo} />
    <input ref={musicInputRef} className="hidden-input" type="file" accept="audio/*" onChange={importMusic} />
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><i></i><i></i></span><strong>DashCut <em>极剪</em></strong></div>
      <div className="project-title"><button>‹</button><div><strong>城市漫游</strong><span>已自动保存 · 刚刚</span></div><button>⌄</button></div>
      <div className="top-actions"><button className="ghost">↶</button><button className="ghost disabled">↷</button><button className="ghost hide-mobile">快捷键</button><button className="export-button" onClick={() => setExportOpen(true)}>导出视频 <span>↗</span></button><button className="avatar">林</button></div>
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
          }} onEnded={() => setPlaying(false)} /> : <button className="empty-stage" onClick={() => videoInputRef.current?.click()}><span>＋</span><strong>导入视频开始创作</strong><small>支持一次选择多个视频片段</small></button>}
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
      {exporting ? <div className="export-progress"><div className="progress-ring" style={{ "--progress": `${progress * 3.6}deg` } as React.CSSProperties}><span>{progress}%</span></div><h3>{progress === 100 ? "导出完成" : "正在渲染视频"}</h3><p>{progress === 100 ? "项目设置已准备好，可保存到本地。" : `正在合成双语字幕与音频 · ${exportFps} FPS`}</p>{progress === 100 && <button className="primary" onClick={downloadProject}>保存项目文件</button>}</div> : <div className="export-form">
        <label>发布平台<div className="platform-cards"><button className={platform === "bilibili" ? "active bili" : "bili"} onClick={() => setPlatform("bilibili")}><b>哔</b><span>哔哩哔哩<small>1080P · 高码率</small></span><i>✓</i></button><button className={platform === "youtube" ? "active youtube" : "youtube"} onClick={() => setPlatform("youtube")}><b>▶</b><span>YouTube<small>1080P · H.264</small></span><i>✓</i></button></div></label>
        <div className="export-grid"><label>分辨率<select defaultValue="1080"><option value="1080">1080P (1920×1080)</option><option value="2160">4K (3840×2160)</option><option value="720">720P (1280×720)</option></select></label><label>帧率<div className="segmented"><button className={exportFps === 30 ? "active" : ""} onClick={() => setExportFps(30)}>30 FPS</button><button className={exportFps === 60 ? "active" : ""} onClick={() => setExportFps(60)}>60 FPS</button></div></label></div>
        <label className="check-row"><input type="checkbox" defaultChecked/><span><strong>内嵌双语字幕</strong><small>中文字幕 + English</small></span></label>
        <div className="export-summary"><span>预计大小</span><strong>{exportFps === 60 ? "428 MB" : "286 MB"}</strong><i></i><span>预计用时</span><strong>约 2 分钟</strong></div>
        <button className="primary full large" onClick={startExport}>开始导出 · {exportFps} FPS</button>
      </div>}
    </section></div>}

    {hardwareOpen && <div className="modal-backdrop" onMouseDown={() => setHardwareOpen(false)}><section className="hardware-modal" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span className="eyebrow">LOCAL AI CHECK</span><h2>本地字幕硬件检测</h2></div><button onClick={() => setHardwareOpen(false)}>×</button></header>
      {!window.dashCutDesktop ? <div className="hardware-empty"><b>请在 DashCut 极剪桌面版中运行检测</b><p>浏览器无法读取完整的 CPU、GPU、内存和磁盘信息。本地 faster-whisper 只在 Windows / macOS 桌面应用中提供。</p></div> : checkingHardware ? <div className="hardware-empty"><b>正在检查设备…</b><p>检测 CPU、NVIDIA CUDA GPU、系统内存、磁盘和内置 AI 运行时。</p></div> : hardware && <div className="hardware-content">
        <div className={`hardware-verdict ${hardware.assessment.tier}`}><span>{hardware.assessment.tier === "recommended" ? "✓" : hardware.assessment.tier === "minimum" ? "!" : "×"}</span><div><b>{hardware.assessment.tier === "recommended" ? "达到推荐配置" : hardware.assessment.tier === "minimum" ? "达到最低配置" : "暂不适合本地识别"}</b><small>{hardware.assessment.tier === "unsupported" ? "建议使用云端模型" : `建议 ${hardware.assessment.model} · ${hardware.assessment.computeType}`}</small></div></div>
        <div className="hardware-grid"><div><span>CPU</span><b>{hardware.cpu.model}</b><small>{hardware.cpu.logicalCores} 个逻辑核心</small></div><div><span>系统内存</span><b>{hardware.memory.totalGb} GB</b><small>当前可用 {hardware.memory.freeGb} GB</small></div><div><span>图形处理器</span><b>{hardware.gpus[0]?.name || "未检测到独立 GPU"}</b><small>{hardware.gpus[0]?.fasterWhisperAcceleration ? `${hardware.gpus[0].memoryGb ?? "未知"} GB VRAM · CUDA` : "faster-whisper 将使用 CPU"}</small></div><div><span>可用磁盘</span><b>{hardware.diskFreeGb} GB</b><small>建议预留至少 10 GB</small></div></div>
        <div className="runtime-status"><strong>内置运行时</strong><span className={hardware.runtime?.ready ? "ready" : ""}>{hardware.runtime?.ready ? `${hardware.runtime.kind === "bundled" ? "随安装包提供" : "开发环境"} · faster-whisper ${hardware.runtime.info?.fasterWhisper ?? ""}` : "不可用，请重新安装 DashCut 极剪"}</span></div>
        {!!hardware.assessment.blockers.length && <div className="hardware-messages blockers"><b>需要解决</b>{hardware.assessment.blockers.map((item) => <span key={item}>• {item}</span>)}</div>}
        {!!hardware.assessment.notes.length && <div className="hardware-messages"><b>检测说明</b>{hardware.assessment.notes.map((item) => <span key={item}>• {item}</span>)}</div>}
        <div className="requirements-table"><div><b>最低配置</b><span>4 核 CPU</span><span>8 GB RAM</span><span>4 GB 空间</span><small>small · CPU INT8</small></div><div><b>推荐配置</b><span>8 核 CPU</span><span>16 GB RAM</span><span>NVIDIA 8 GB VRAM</span><small>large-v3 · CUDA FP16</small></div></div>
        <section className="model-manager"><header><div><b>选择推理模型</b><small>默认不下载，仅在你点击后安装</small></div><span>推荐：{hardware.assessment.model}</span></header><div className="model-list">{localModels.map((model) => <button key={model.id} className={`${selectedModel === model.id ? "selected" : ""} ${model.id === hardware.assessment.model ? "recommended" : ""}`} onClick={() => setSelectedModel(model.id)}><span className="model-radio">{selectedModel === model.id ? "●" : "○"}</span><div><b>{model.label} {model.id === hardware.assessment.model && <i>推荐</i>}</b><small>{model.description} · 约 {model.approximateGb} GB</small></div>{model.installed ? <span className="model-installed">已安装</span> : <span className="model-not-installed">未下载</span>}</button>)}</div>
          {localModels.find((model) => model.id === selectedModel)?.installed ? <div className="model-action-row"><span>模型已就绪，可离线使用</span><button onClick={() => void removeLocalModel(selectedModel)}>删除模型</button></div> : <button className="primary full" disabled={Boolean(installingModel) || hardware.assessment.tier === "unsupported" || !hardware.runtime?.ready} onClick={() => void installLocalModel(selectedModel)}>{installingModel === selectedModel ? `正在下载安装 ${selectedModel}…` : `下载安装 ${selectedModel} · 约 ${localModels.find((model) => model.id === selectedModel)?.approximateGb ?? "-"} GB`}</button>}
        </section>
        <div className="hardware-actions"><button className="ghost-action" onClick={() => void checkHardware()}>重新检测</button><button className="primary" disabled={hardware.assessment.tier === "unsupported" || !localModels.find((model) => model.id === selectedModel)?.installed} onClick={() => { setRecognitionEngine("local"); setHardwareOpen(false); setToast(`已选择本地 ${selectedModel} 模型`); }}>使用本地模型</button></div>
      </div>}
    </section></div>}

    {toast && <div className="toast"><span>✓</span>{toast}</div>}
  </main>;
}
