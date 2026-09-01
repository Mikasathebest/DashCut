/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");

function resolveFfmpegExecutable(options = {}) {
  if (options.ffmpegPath) return options.ffmpegPath;
  if (process.env.DASHCUT_FFMPEG_PATH) return process.env.DASHCUT_FFMPEG_PATH;
  const localRuntime = path.join(__dirname, "..", "media-runtime", "current", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  return existsSync(localRuntime) ? localRuntime : process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

function targetBitrate(width, height, fps, destination) {
  const pixelsPerSecond = width * height * fps;
  const base = pixelsPerSecond >= 3840 * 2160 * 50 ? 45_000
    : pixelsPerSecond >= 3840 * 2160 * 25 ? 32_000
      : pixelsPerSecond >= 1920 * 1080 * 50 ? 14_000
        : pixelsPerSecond >= 1920 * 1080 * 25 ? 9_000
          : 5_000;
  return destination === "bilibili" ? Math.round(base * 1.1) : base;
}

function videoEncoderArgs(platform, settings) {
  const bitrate = targetBitrate(settings.width, settings.height, settings.fps, settings.destination);
  if (platform === "darwin") {
    return ["-c:v", "h264_videotoolbox", "-profile:v", "high", "-allow_sw", "1", "-realtime", "0", "-b:v", `${bitrate}k`, "-maxrate", `${Math.round(bitrate * 1.35)}k`, "-bufsize", `${bitrate * 2}k`];
  }
  if (platform === "win32") {
    return ["-c:v", "h264_mf", "-hw_encoding", settings.hardware === false ? "0" : "1", "-rate_control", "quality", "-quality", settings.finalPass ? "82" : "76", "-b:v", `${bitrate}k`];
  }
  throw new Error(`当前平台 ${platform} 尚未提供 LGPL H.264 编码器`);
}

function encoderPixelFormat(platform) {
  return platform === "win32" ? "nv12" : "yuv420p";
}

function assTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = Math.floor(value % 60);
  const centiseconds = Math.floor((value % 1) * 100);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

function srtTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = Math.floor(value % 60);
  const millis = Math.floor((value % 1) * 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function assColor(hex) {
  const value = String(hex || "#ffffff").replace("#", "").padEnd(6, "f").slice(0, 6);
  return `&H00${value.slice(4, 6)}${value.slice(2, 4)}${value.slice(0, 2).toUpperCase()}`;
}

function escapeAss(text) {
  return String(text || "").replace(/\\/g, "\\\\").replace(/[{}]/g, "").replace(/\r?\n/g, "\\N");
}

function escapeFilterPath(target) {
  return target.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,");
}

function createAss(subtitles, style, width, height) {
  const font = String(style.fontFamily || "Arial").split(",")[0].replace(/["']/g, "").trim();
  const fontSize = Math.max(16, Number(style.fontSize) || 34) * (height / 1080);
  const outline = Math.max(0, Number(style.outlineWidth) || 0) * (height / 1080);
  const dialogues = subtitles.map((subtitle) => {
    const lines = [subtitle.zh, subtitle.en].filter(Boolean).map(escapeAss).join("\\N");
    return `Dialogue: 0,${assTime(subtitle.start)},${assTime(subtitle.end)},Default,,0,0,0,,${lines}`;
  }).join("\n");
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,${font},${fontSize.toFixed(1)},${assColor(style.color)},${assColor(style.color)},${assColor(style.outlineColor)},&H80000000,-1,0,0,0,100,100,0,0,1,${outline.toFixed(1)},1,2,80,80,60,1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n${dialogues}\n`;
}

function createSrt(subtitles, field) {
  return subtitles.filter((item) => item[field]).map((item, index) => `${index + 1}\n${srtTime(item.start)} --> ${srtTime(item.end)}\n${item[field]}\n`).join("\n");
}

function runFfmpeg(args, onTime, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveFfmpegExecutable(options), ["-hide_banner", "-y", ...args], { windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-30_000);
      const matches = [...chunk.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
      const latest = matches.at(-1);
      if (latest && onTime) onTime(Number(latest[1]) * 3600 + Number(latest[2]) * 60 + Number(latest[3]));
    });
    child.on("error", (error) => reject(error.code === "ENOENT" ? new Error("安装包缺少 LGPL FFmpeg 运行时，请重新安装 DashCut 极剪") : error));
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.split(/\r?\n/).filter(Boolean).slice(-8).join("\n") || `FFmpeg exited with ${code}`)));
  });
}

async function normalizeSegment(segment, output, settings, onProgress) {
  const clipDuration = segment.sourceEnd - segment.sourceStart;
  const scale = `scale=${settings.width}:${settings.height}:force_original_aspect_ratio=decrease,pad=${settings.width}:${settings.height}:(ow-iw)/2:(oh-ih)/2:black,fps=${settings.fps},format=${encoderPixelFormat(settings.platform)}`;
  const common = ["-ss", String(segment.sourceStart), "-t", String(clipDuration), "-i", segment.path];
  const hardwareModes = settings.platform === "win32" ? [true, false] : [undefined];
  let lastError;
  for (const hardware of hardwareModes) {
    const videoArgs = videoEncoderArgs(settings.platform, { ...settings, finalPass: false, hardware });
    try {
      await runFfmpeg([...common, "-map", "0:v:0", "-map", "0:a:0", "-vf", scale, "-af", "aresample=async=1:first_pts=0", ...videoArgs, "-c:a", "aac", "-ar", "48000", "-ac", "2", "-tag:v", "avc1", output], onProgress, settings);
      return;
    } catch (error) {
      lastError = error;
    }
    try {
      await runFfmpeg([...common, "-f", "lavfi", "-t", String(clipDuration), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000", "-map", "0:v:0", "-map", "1:a:0", "-vf", scale, ...videoArgs, "-c:a", "aac", "-tag:v", "avc1", "-shortest", output], onProgress, settings);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function exportVideo(request, options) {
  if (!Array.isArray(request.segments) || !request.segments.length) throw new Error("时间线中没有可导出的视频");
  const resolution = request.resolution === 2160 ? [3840, 2160] : request.resolution === 720 ? [1280, 720] : [1920, 1080];
  const fps = request.fps === 60 ? 60 : 30;
  const totalDuration = request.segments.reduce((sum, item) => sum + item.sourceEnd - item.sourceStart, 0);
  const tempDir = await mkdtemp(path.join(options.tempPath, "dashcut-export-"));
  const emit = (progress, stage) => options.onProgress?.({ progress: Math.max(0, Math.min(100, Math.round(progress))), stage });
  try {
    const assPath = path.join(tempDir, "subtitles.ass");
    await writeFile(assPath, createAss(request.subtitles || [], request.subtitleStyle || {}, resolution[0], resolution[1]), "utf8");
    const normalized = [];
    let completedDuration = 0;
    for (const [index, segment] of request.segments.entries()) {
      const output = path.join(tempDir, `segment-${String(index).padStart(4, "0")}.mp4`);
      const duration = segment.sourceEnd - segment.sourceStart;
      await normalizeSegment(segment, output, { width: resolution[0], height: resolution[1], fps, destination: request.platform, platform: options.platform ?? process.platform, ffmpegPath: options.ffmpegPath }, (time) => emit(((completedDuration + Math.min(time, duration)) / totalDuration) * 60, `正在处理片段 ${index + 1}/${request.segments.length}`));
      completedDuration += duration;
      normalized.push(output);
    }

    const concatPath = path.join(tempDir, "concat.txt");
    await writeFile(concatPath, normalized.map((file) => `file '${file.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
    const joinedPath = path.join(tempDir, "joined.mp4");
    emit(62, "正在合并视频片段");
    await runFfmpeg(["-f", "concat", "-safe", "0", "-i", concatPath, "-c", "copy", joinedPath], undefined, options);

    const assFilter = `ass='${escapeFilterPath(assPath)}'`;
    const finalArgs = ["-i", joinedPath];
    if (request.musicPath) {
      finalArgs.push("-stream_loop", "-1", "-i", request.musicPath, "-filter_complex", `[0:v]${assFilter}[v];[0:a][1:a]amix=inputs=2:duration=first:weights='1 ${Math.max(0, Math.min(1, Number(request.musicVolume) || 0.35))}'[a]`, "-map", "[v]", "-map", "[a]");
    } else {
      finalArgs.push("-vf", assFilter, "-map", "0:v:0", "-map", "0:a:0");
    }
    const exportPlatform = options.platform ?? process.platform;
    const hardwareModes = exportPlatform === "win32" ? [true, false] : [undefined];
    let finalError;
    for (const hardware of hardwareModes) {
      const encoderArgs = videoEncoderArgs(exportPlatform, { width: resolution[0], height: resolution[1], fps, destination: request.platform, finalPass: true, hardware });
      try {
        await runFfmpeg([...finalArgs, ...encoderArgs, "-pix_fmt", encoderPixelFormat(exportPlatform), "-tag:v", "avc1", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", options.outputPath], (time) => emit(65 + (Math.min(time, totalDuration) / totalDuration) * 34, hardware === false ? "正在使用兼容模式完成导出" : "正在烧录字幕和混合音频"), options);
        finalError = undefined;
        break;
      } catch (error) {
        finalError = error;
      }
    }
    if (finalError) throw finalError;

    const base = options.outputPath.replace(/\.[^.]+$/, "");
    await Promise.all([
      writeFile(`${base}.zh.srt`, createSrt(request.subtitles || [], "zh"), "utf8"),
      writeFile(`${base}.en.srt`, createSrt(request.subtitles || [], "en"), "utf8"),
    ]);
    emit(100, "导出完成");
    return { outputPath: options.outputPath, duration: totalDuration, subtitleFiles: [`${base}.zh.srt`, `${base}.en.srt`] };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

module.exports = { createAss, createSrt, exportVideo, resolveFfmpegExecutable, videoEncoderArgs };
