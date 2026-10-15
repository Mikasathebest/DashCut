/* eslint-disable @typescript-eslint/no-require-imports */
// Offline dubbing: synthesise translated caption lines with the operating
// system's own voices (macOS `say`, Windows System.Speech) and lay them out on
// one 48 kHz stereo WAV aligned to the caption timing. No cloud, no models.
const { spawn } = require("node:child_process");
const { mkdir, mkdtemp, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { resolveFfmpegExecutable } = require("./video-export.cjs");

const SAMPLE_RATE = 48000;
const MIX_BATCH = 24;

function runProcess(command, args, { input, encoding = "utf8" } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, shell: false });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding(encoding);
    child.stderr.setEncoding(encoding);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-64_000); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function lastLines(text, count = 4) {
  return String(text || "").trim().split(/\r?\n/).filter(Boolean).slice(-count).join(" ").slice(0, 400);
}

function normalizeLanguage(code) {
  const value = String(code || "").trim().replace(/_/g, "-");
  if (!value) return "";
  const [lang, ...rest] = value.split("-");
  return [lang.toLowerCase(), ...rest.map((part) => (/^[a-z]{2}$/i.test(part) ? part.toUpperCase() : part))].join("-");
}

// macOS ships joke voices ("Bad News", "Bubbles", ...) that must never be the default pick.
const NOVELTY_VOICES = new Set([
  "Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos", "Good News", "Jester", "Organ", "Superstar", "Trinoids", "Whisper", "Wobble", "Zarvox",
]);
const PREFERRED_VOICES = ["Samantha", "Tingting", "Meijia", "Sinji", "Daniel", "Karen", "Kyoko", "Yuna", "Thomas", "Anna", "Microsoft Huihui", "Microsoft Zira"];

function voiceRank(voice) {
  if (NOVELTY_VOICES.has(voice.name)) return 2;
  return PREFERRED_VOICES.some((name) => voice.name === name || voice.name.startsWith(`${name} `)) ? 0 : 1;
}

function findVoiceForLanguage(voices, wanted) {
  const target = normalizeLanguage(wanted).toLowerCase();
  if (!target) return null;
  const base = target.split("-")[0];
  const ranked = [...voices].sort((a, b) => voiceRank(a) - voiceRank(b));
  return ranked.find((item) => normalizeLanguage(item.language).toLowerCase() === target)
    || ranked.find((item) => normalizeLanguage(item.language).toLowerCase().split("-")[0] === base)
    || null;
}

// `say -v '?'` lines look like: "Eddy (Chinese (China mainland)) zh_CN    # 你好！我叫Eddy。"
function parseMacVoices(output) {
  const voices = [];
  const seen = new Set();
  for (const raw of String(output || "").split(/\r?\n/)) {
    const match = raw.match(/^(.+?)\s+([A-Za-z]{2,3}(?:[_-][A-Za-z0-9]+)*)\s+#/);
    if (!match) continue;
    const name = match[1].trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    voices.push({ id: name, name, language: normalizeLanguage(match[2]) });
  }
  return voices;
}

function parseWindowsVoices(output) {
  const voices = [];
  for (const raw of String(output || "").split(/\r?\n/)) {
    const line = raw.trim();
    const index = line.lastIndexOf("|");
    if (index <= 0) continue;
    const name = line.slice(0, index).trim();
    voices.push({ id: name, name, language: normalizeLanguage(line.slice(index + 1)) });
  }
  return voices;
}

const POWERSHELL_LIST = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | % { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }";

// Parameters reach the script through argv; the text itself through a UTF-8 file.
const POWERSHELL_SYNTH = [
  "param([string]$TextPath, [string]$OutPath, [string]$Voice, [int]$Rate)",
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Speech",
  "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  "try {",
  "  if ($Voice) { $s.SelectVoice($Voice) }",
  "  $s.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))",
  "  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)",
  "  $s.SetOutputToWaveFile($OutPath, $fmt)",
  "  $text = [System.IO.File]::ReadAllText($TextPath, [System.Text.Encoding]::UTF8)",
  "  $s.Speak($text)",
  "} finally { $s.Dispose() }",
].join("\r\n");

function powershellArgs(extra) {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...extra];
}

async function listVoices({ platform = process.platform } = {}) {
  if (platform === "darwin") {
    const result = await runProcess("say", ["-v", "?"]).catch(() => null);
    if (!result || result.code !== 0) return [];
    return parseMacVoices(result.stdout);
  }
  if (platform === "win32") {
    const result = await runProcess("powershell.exe", powershellArgs(["-Command", POWERSHELL_LIST])).catch(() => null);
    if (!result || result.code !== 0) return [];
    return parseWindowsVoices(result.stdout);
  }
  return [];
}

// `rate` is words per minute (macOS `say` semantics). Windows SAPI uses -10..10
// around a default of roughly 180 wpm.
function windowsRate(rate) {
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return Math.max(-10, Math.min(10, Math.round((rate - 180) / 18)));
}

async function synthesizeLine({ text, voice, rate, outputPath, platform = process.platform, tempPath } = {}) {
  const content = String(text ?? "").trim();
  if (!content) throw new Error("语音合成失败：文本为空");
  if (!outputPath) throw new Error("语音合成失败：缺少输出路径");
  if (platform !== "darwin" && platform !== "win32") throw new Error("语音合成失败：当前系统不支持离线语音合成");
  await mkdir(path.dirname(outputPath), { recursive: true });
  const workDir = await mkdtemp(path.join(tempPath || os.tmpdir(), "dashcut-tts-"));
  try {
    const textPath = path.join(workDir, "line.txt");
    await writeFile(textPath, content, "utf8");
    let result;
    if (platform === "darwin") {
      const wave = /\.wav$/i.test(outputPath);
      const args = [];
      if (voice) args.push("-v", String(voice));
      if (Number.isFinite(rate) && rate > 0) args.push("-r", String(Math.round(rate)));
      args.push("-f", textPath, "-o", outputPath);
      args.push(...(wave ? ["--file-format=WAVE", `--data-format=LEI16@${SAMPLE_RATE}`] : [`--data-format=BEI16@${SAMPLE_RATE}`]));
      result = await runProcess("say", args);
    } else {
      const scriptPath = path.join(workDir, "synth.ps1");
      await writeFile(scriptPath, `﻿${POWERSHELL_SYNTH}`, "utf8");
      result = await runProcess("powershell.exe", powershellArgs([
        "-File", scriptPath, "-TextPath", textPath, "-OutPath", outputPath, "-Voice", String(voice || ""), "-Rate", String(windowsRate(rate)),
      ]));
    }
    if (result.code !== 0) throw new Error(`语音合成失败：${lastLines(result.stderr || result.stdout) || `退出码 ${result.code}`}`);
    return { outputPath };
  } catch (error) {
    if (error && /^语音合成失败/.test(error.message)) throw error;
    throw new Error(`语音合成失败：${error?.message || error}`);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Time-fit one synthesised line into its slot. Never slows down; speeds up to
// maxSpeedup; anything still too long overflows (runs over) instead of truncating.
function fitLine(duration, slot, maxSpeedup = 1.6) {
  const length = Math.max(0, Number(duration) || 0);
  const room = Math.max(0, Number(slot) || 0);
  const cap = Math.max(1, Number(maxSpeedup) || 1);
  if (length <= 0) return { speedup: 1, duration: 0, overflow: 0 };
  if (room <= 0) return { speedup: cap, duration: length / cap, overflow: length / cap };
  const needed = length / room;
  const speedup = needed <= 1 ? 1 : Math.min(needed, cap);
  const fitted = length / speedup;
  const overflow = Math.max(0, fitted - room);
  return { speedup, duration: fitted, overflow: overflow < 1e-6 ? 0 : overflow };
}

// atempo accepts 0.5..100 on new FFmpeg but only up to 2.0 on old builds; chain to be safe.
function atempoChain(speedup) {
  const parts = [];
  let remaining = speedup;
  while (remaining > 2) { parts.push("atempo=2"); remaining /= 2; }
  if (Math.abs(remaining - 1) > 1e-4) parts.push(`atempo=${remaining.toFixed(5)}`);
  return parts;
}

async function runFfmpeg(ffmpeg, args, label) {
  const result = await runProcess(ffmpeg, ["-hide_banner", "-nostdin", "-y", ...args]).catch((error) => {
    throw new Error(`${label}：无法启动 FFmpeg（${error.message}）`);
  });
  if (result.code !== 0) throw new Error(`${label}：${lastLines(result.stderr) || `FFmpeg 退出码 ${result.code}`}`);
  return result;
}

async function measureDuration(ffmpeg, file) {
  const result = await runProcess(ffmpeg, ["-hide_banner", "-nostdin", "-i", file, "-map", "0:a:0", "-f", "null", "-"]).catch((error) => {
    throw new Error(`语音合成失败：无法启动 FFmpeg（${error.message}）`);
  });
  if (result.code !== 0) throw new Error(`语音合成失败：无法读取合成音频（${lastLines(result.stderr)}）`);
  const times = [...result.stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  if (times.length) {
    const [, h, m, s] = times[times.length - 1];
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
  }
  const header = result.stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return header ? Number(header[1]) * 3600 + Number(header[2]) * 60 + Number(header[3]) : 0;
}

function pickVoice(voices, { voice, language, platform }) {
  if (voice) {
    const exact = voices.find((item) => item.id === voice || item.name === voice);
    if (exact) return exact;
    if (!voices.length && (platform === "darwin" || platform === "win32")) return { id: voice, name: voice, language: normalizeLanguage(language) };
    if (!language) throw new Error(`系统没有可用的 ${voice} 语音`);
  }
  if (language) {
    const match = findVoiceForLanguage(voices, language);
    if (!match) throw new Error(`系统没有可用的 ${language} 语音`);
    return match;
  }
  if (!voices.length) throw new Error("系统没有可用的离线语音");
  return null;
}

// Mix positioned clips ([{ file, delayMs }]) into one fixed-length stereo WAV.
async function mixClips(ffmpeg, clips, total, outputPath, workDir, onStep) {
  if (!clips.length) {
    await runFfmpeg(ffmpeg, ["-f", "lavfi", "-i", `anullsrc=r=${SAMPLE_RATE}:cl=stereo`, "-t", total.toFixed(6), "-c:a", "pcm_s16le", outputPath], "配音混音失败");
    return;
  }
  let layer = clips;
  let round = 0;
  while (layer.length > MIX_BATCH) {
    const next = [];
    for (let index = 0; index < layer.length; index += MIX_BATCH) {
      const partPath = path.join(workDir, `mix-${round}-${index}.wav`);
      await mixBatch(ffmpeg, layer.slice(index, index + MIX_BATCH), total, partPath, "pcm_f32le");
      next.push({ file: partPath, delayMs: 0 });
      onStep?.();
    }
    layer = next;
    round += 1;
  }
  await mixBatch(ffmpeg, layer, total, outputPath, "pcm_s16le");
}

async function mixBatch(ffmpeg, clips, total, outputPath, codec) {
  const args = [];
  const chains = [];
  clips.forEach((clip, index) => {
    args.push("-i", clip.file);
    const delay = Math.max(0, Math.round(clip.delayMs));
    chains.push(`[${index}:a]aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo${delay ? `,adelay=${delay}:all=1` : ""}[a${index}]`);
  });
  const labels = clips.map((_, index) => `[a${index}]`).join("");
  const mix = clips.length > 1 ? `${labels}amix=inputs=${clips.length}:duration=longest:dropout_transition=0:normalize=0` : `${labels}anull`;
  const filter = `${chains.join(";")};${mix},apad=whole_dur=${total.toFixed(6)},atrim=0:${total.toFixed(6)}[out]`;
  await runFfmpeg(ffmpeg, [...args, "-filter_complex", filter, "-map", "[out]", "-ar", String(SAMPLE_RATE), "-ac", "2", "-c:a", codec, outputPath], "配音混音失败");
}

async function renderDub({
  lines = [], voice, language, rate, platform = process.platform, outputPath, tempPath, ffmpegPath, maxSpeedup = 1.6, onProgress,
} = {}) {
  if (!outputPath) throw new Error("配音生成失败：缺少输出路径");
  const ffmpeg = resolveFfmpegExecutable({ ffmpegPath });
  const progress = (value) => { try { onProgress?.(Math.max(0, Math.min(1, value))); } catch { /* ignore listener errors */ } };

  const timed = lines
    .map((line, index) => ({ index, start: Number(line?.start), end: Number(line?.end), text: String(line?.text ?? "").trim() }))
    .filter((line) => Number.isFinite(line.start) && Number.isFinite(line.end));
  const ordered = [...timed].sort((a, b) => a.start - b.start || a.index - b.index);
  const timelineEnd = ordered.reduce((max, line) => Math.max(max, line.end, line.start), 0);
  const spoken = ordered.filter((line) => line.text);

  let chosen = null;
  if (spoken.length) {
    const voices = await listVoices({ platform });
    chosen = pickVoice(voices, { voice, language, platform });
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  const base = tempPath || os.tmpdir();
  await mkdir(base, { recursive: true });
  const workDir = await mkdtemp(path.join(base, "dashcut-dub-"));
  progress(0);
  try {
    const steps = spoken.length * 2 + 1;
    let done = 0;
    const step = () => { done += 1; progress(Math.min(0.99, done / steps)); };
    const results = [];
    const clips = [];
    for (let i = 0; i < spoken.length; i += 1) {
      const line = spoken[i];
      const nextStart = spoken.slice(i + 1).find((other) => other.start > line.start)?.start;
      const slotEnd = Number.isFinite(nextStart) ? nextStart : Math.max(line.end, line.start);
      const slot = Math.max(0, slotEnd - line.start);
      const rawPath = path.join(workDir, `line-${i}.${platform === "win32" ? "wav" : "aiff"}`);
      await synthesizeLine({ text: line.text, voice: chosen?.id, rate, outputPath: rawPath, platform, tempPath: workDir });
      const rawDuration = await measureDuration(ffmpeg, rawPath);
      step();
      const fit = fitLine(rawDuration, slot, maxSpeedup);
      const fittedPath = path.join(workDir, `fit-${i}.wav`);
      const filters = [
        `aresample=${SAMPLE_RATE}`,
        ...atempoChain(fit.speedup),
        "loudnorm=I=-18:TP=-1.5:LRA=11",
        `aresample=${SAMPLE_RATE}`,
        "aformat=sample_fmts=s16:channel_layouts=stereo",
      ];
      await runFfmpeg(ffmpeg, ["-i", rawPath, "-af", filters.join(","), "-ar", String(SAMPLE_RATE), "-ac", "2", "-c:a", "pcm_s16le", fittedPath], "语音合成失败");
      const fittedDuration = await measureDuration(ffmpeg, fittedPath);
      step();
      const overflow = Math.max(0, fittedDuration - slot);
      clips.push({ file: fittedPath, delayMs: line.start * 1000, end: line.start + fittedDuration });
      results.push({
        start: line.start,
        end: line.end,
        spoken: Number(fittedDuration.toFixed(3)),
        speedup: Number(fit.speedup.toFixed(4)),
        overflow: overflow > 0.02 ? Number(overflow.toFixed(3)) : 0,
      });
    }
    const total = Math.max(timelineEnd, ...clips.map((clip) => clip.end), 0.1);
    await mixClips(ffmpeg, clips, total, outputPath, workDir, () => {});
    step();
    progress(1);
    return { outputPath, duration: Number(total.toFixed(3)), voice: chosen?.id || null, lines: results };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  atempoChain,
  findVoiceForLanguage,
  fitLine,
  listVoices,
  normalizeLanguage,
  parseMacVoices,
  parseWindowsVoices,
  renderDub,
  synthesizeLine,
  windowsRate,
};
