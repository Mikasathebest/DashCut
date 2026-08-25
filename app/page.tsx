"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

type Segment = { id: number; start: number; end: number; color: string };
type Subtitle = { id: number; start: number; end: number; zh: string; en: string };
type Panel = "media" | "audio" | "text" | "subtitles" | "cover" | "effects";

const demoSubtitles: Subtitle[] = [
  { id: 1, start: 0, end: 3.2, zh: "欢迎来到今天的视频", en: "Welcome to today’s video" },
  { id: 2, start: 3.2, end: 7.1, zh: "我们来聊聊如何让创作更简单", en: "Let’s make video creation feel effortless" },
  { id: 3, start: 7.1, end: 11.6, zh: "从剪辑到字幕，一次完成", en: "From editing to captions, all in one place" },
  { id: 4, start: 11.6, end: 15.8, zh: "准备好了吗？我们开始吧", en: "Ready? Let’s get started" },
];

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

export default function Home() {
  const [panel, setPanel] = useState<Panel>("subtitles");
  const [videoUrl, setVideoUrl] = useState("");
  const [videoName, setVideoName] = useState("城市漫游_最终版.mp4");
  const [musicName, setMusicName] = useState("日落之后 · Lo-fi Mix");
  const [duration, setDuration] = useState(62.4);
  const [current, setCurrent] = useState(12.24);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [ratio, setRatio] = useState("16:9");
  const [subtitleMode, setSubtitleMode] = useState<"zh" | "en" | "both">("both");
  const [subtitles, setSubtitles] = useState<Subtitle[]>(demoSubtitles);
  const [segments, setSegments] = useState<Segment[]>([
    { id: 1, start: 0, end: 17.8, color: "#5c82ff" },
    { id: 2, start: 17.8, end: 34.2, color: "#78a1ff" },
    { id: 3, start: 34.2, end: 48.7, color: "#6d8df5" },
    { id: 4, start: 48.7, end: 62.4, color: "#86a8ff" },
  ]);
  const [selectedSegment, setSelectedSegment] = useState(1);
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
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const musicInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const activeSubtitle = useMemo(
    () => subtitles.find((item) => current >= item.start && current < item.end) ?? subtitles[2],
    [current, subtitles],
  );

  useEffect(() => {
    if (!videoUrl || !videoRef.current) return;
    if (playing) videoRef.current.play().catch(() => setPlaying(false));
    else videoRef.current.pause();
  }, [playing, videoUrl]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(""), 2400);
    return () => window.clearTimeout(id);
  }, [toast]);

  function importVideo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(URL.createObjectURL(file));
    setVideoName(file.name);
    setCurrent(0);
    setPlaying(false);
    setToast("视频已导入时间轴");
  }

  function importMusic(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setMusicName(file.name.replace(/\.[^.]+$/, ""));
    setPanel("audio");
    setToast("背景音乐已添加");
  }

  function splitClip() {
    const index = segments.findIndex((segment) => current > segment.start + 0.3 && current < segment.end - 0.3);
    if (index === -1) {
      setToast("请把播放头移到片段中间");
      return;
    }
    const target = segments[index];
    const nextId = Math.max(...segments.map((segment) => segment.id)) + 1;
    const replacement = [
      { ...target, end: current },
      { id: nextId, start: current, end: target.end, color: "#91adff" },
    ];
    setSegments([...segments.slice(0, index), ...replacement, ...segments.slice(index + 1)]);
    setSelectedSegment(nextId);
    setToast(`已在 ${formatTime(current)} 分割`);
  }

  function removeClip() {
    if (segments.length <= 1) return setToast("至少保留一个视频片段");
    const selected = segments.find((segment) => segment.id === selectedSegment);
    setSegments(segments.filter((segment) => segment.id !== selectedSegment));
    setSelectedSegment(segments.find((segment) => segment.id !== selectedSegment)?.id ?? 1);
    setToast(selected ? `已移除 ${formatTime(selected.start)} 的片段` : "片段已移除");
  }

  function seekFromPointer(event: React.PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const next = Math.max(0, Math.min(duration, ((event.clientX - rect.left) / rect.width) * duration));
    setCurrent(next);
    if (videoRef.current) videoRef.current.currentTime = next;
  }

  function generateSubtitles() {
    setIsGenerating(true);
    window.setTimeout(() => {
      setSubtitles(demoSubtitles);
      setIsGenerating(false);
      setToast("字幕识别完成，准确率 96%");
    }, 1400);
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
    const payload = { project: "城市漫游", platform, fps: exportFps, ratio, subtitles, segments, music: musicName };
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    link.download = "frameflow-project.json";
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
    ctx.fillText("FRAMEFLOW 原创视频", 126, 565);
    if (download) {
      const link = document.createElement("a");
      link.href = canvas.toDataURL("image/png");
      link.download = "视频封面.png";
      link.click();
      setToast("封面图已保存");
    }
  }

  useEffect(() => {
    if (coverOpen) renderCover(false);
  }, [coverOpen, coverTitle, coverAccent]);

  const panelContent = {
    media: <>
      <div className="panel-heading"><div><span className="eyebrow">MEDIA</span><h2>项目媒体</h2></div><button className="icon-button">•••</button></div>
      <button className="upload-card" onClick={() => videoInputRef.current?.click()}><span>＋</span><strong>导入本地视频</strong><small>MP4、MOV、WebM，最大 4K</small></button>
      <h3 className="section-title">当前素材</h3>
      <div className="media-card"><div className="media-thumb"><span>▶</span></div><div><strong>{videoName}</strong><small>{formatTime(duration)} · 1920×1080</small></div></div>
    </>,
    audio: <>
      <div className="panel-heading"><div><span className="eyebrow">AUDIO</span><h2>背景音乐</h2></div><button className="icon-button">＋</button></div>
      <button className="upload-card audio-upload" onClick={() => musicInputRef.current?.click()}><span>♫</span><strong>添加音乐或音效</strong><small>支持 MP3、WAV、M4A</small></button>
      <h3 className="section-title">已添加</h3>
      <div className="song-card"><button>▶</button><div><strong>{musicName}</strong><small>02:36 · 背景音乐</small></div><span>•••</span></div>
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
      <button className="generate-button" onClick={generateSubtitles} disabled={isGenerating}><span>{isGenerating ? "◌" : "✦"}</span><strong>{isGenerating ? "正在识别人声…" : "重新识别字幕"}</strong><small>{isGenerating ? "正在分析音轨与语义" : "普通话 / English · 自动断句"}</small></button>
      <div className="recognition-meta"><span><i></i> 已完成 · 96% 准确率</span><button>字幕样式 ↗</button></div>
      <div className="subtitle-list">
        {subtitles.map((item) => <div className={`subtitle-row ${current >= item.start && current < item.end ? "active" : ""}`} key={item.id} onClick={() => setCurrent(item.start + 0.05)}>
          <time>{formatTime(item.start).slice(0, 5)}</time><div>
            {subtitleMode !== "en" && <input value={item.zh} onChange={(event) => updateSubtitle(item.id, "zh", event.target.value)} />}
            {subtitleMode !== "zh" && <input className="translation" value={item.en} onChange={(event) => updateSubtitle(item.id, "en", event.target.value)} />}
          </div><button>⋮</button>
        </div>)}
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
    <input ref={videoInputRef} className="hidden-input" type="file" accept="video/*" onChange={importVideo} />
    <input ref={musicInputRef} className="hidden-input" type="file" accept="audio/*" onChange={importMusic} />
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><i></i><i></i></span><strong>FrameFlow</strong></div>
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
          {videoUrl ? <video ref={videoRef} src={videoUrl} muted={muted} onLoadedMetadata={(event) => {
            const nextDuration = event.currentTarget.duration || 62.4;
            setDuration(nextDuration);
            setSegments([{ id: 1, start: 0, end: nextDuration, color: "#668cff" }]);
          }} onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)} onEnded={() => setPlaying(false)} /> : <div className="demo-scene"><div className="sun"></div><div className="mountain m1"></div><div className="mountain m2"></div><div className="road"></div><span className="location-tag">◉ 杭州 · 西湖边</span></div>}
          <div className="caption-preview">
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
            {segments.map((segment) => <button key={segment.id} className={selectedSegment === segment.id ? "selected" : ""} onClick={(event) => { event.stopPropagation(); setSelectedSegment(segment.id); }} style={{ width: `${((segment.end - segment.start) / duration) * 100}%`, background: segment.color }}><i></i><span>{videoName.replace(/\.[^.]+$/, "")}</span></button>)}
          </div>
          <div className="audio-track"><span className="audio-title">♫ {musicName}</span><div className="waveform">{Array.from({ length: 76 }).map((_, index) => <i key={index} style={{ height: `${20 + ((index * 17) % 70)}%` }}></i>)}</div></div>
          <div className="caption-track">{subtitles.map((subtitle) => <button key={subtitle.id} style={{ left: `${(subtitle.start / duration) * 100}%`, width: `${((subtitle.end - subtitle.start) / duration) * 100}%` }}>{subtitle.zh}</button>)}</div>
          <div className="playhead" style={{ left: `${(current / duration) * 100}%` }}><i></i></div>
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

    {toast && <div className="toast"><span>✓</span>{toast}</div>}
  </main>;
}
