/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require("node:child_process");
const { resolveFfmpegExecutable } = require("./video-export.cjs");

const MISSING_RUNTIME = "安装包缺少 LGPL FFmpeg 运行时，请重新安装 DashCut 极剪";
const NO_AUDIO = "该片段没有音频，无法智能剪口播";
const INTERESTING_LINE = /lavfi\.scd|silence_(start|end)|Duration:/;
const NO_AUDIO_PATTERN = /matches no streams|Failed to set value '0:a:0'|does not contain any stream/i;

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function lastLines(stderr, code) {
  return stderr.split(/\r?\n/).filter(Boolean).slice(-8).join("\n") || `FFmpeg exited with ${code}`;
}

function rangeArgs(start, end) {
  const args = [];
  if (start > 0) args.push("-ss", String(start));
  if (Number.isFinite(end) && end > start) args.push("-t", String(end - start));
  return args;
}

// Runs FFmpeg, keeping the full stderr text (the analysis filters log their results there).
// `onStdout` receives raw stdout chunks for streaming consumers.
function runFfmpeg(args, options = {}, onStdout) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveFfmpegExecutable(options), ["-hide_banner", "-nostats", ...args], { windowsHide: true });
    let stderr = "";
    const lines = [];
    let pending = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-30_000);
      const parts = `${pending}${chunk}`.split(/\r?\n/);
      pending = parts.pop();
      for (const line of parts) if (INTERESTING_LINE.test(line)) lines.push(line);
    });
    if (onStdout) child.stdout.on("data", onStdout);
    else child.stdout.resume();
    child.on("error", (error) => reject(error.code === "ENOENT" ? new Error(MISSING_RUNTIME) : error));
    child.on("close", (code) => {
      if (pending && INTERESTING_LINE.test(pending)) lines.push(pending);
      if (code === 0) resolve({ stderr, lines });
      else {
        const error = new Error(lastLines(stderr, code));
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

async function detectScenes(sourcePath, { in: start = 0, out, threshold = 10, minShot = 0.6, ffmpegPath } = {}) {
  const { lines } = await runFfmpeg([
    ...rangeArgs(start, out), "-i", sourcePath,
    "-an", "-sn", "-dn",
    "-vf", `scale=320:-2,scdet=threshold=${threshold}:sc_pass=1`,
    "-f", "null", "-",
  ], { ffmpegPath });
  const end = Number.isFinite(out) ? out : Infinity;
  const cuts = [];
  for (const line of lines) {
    const match = line.match(/lavfi\.scd\.time:\s*(-?\d+(?:\.\d+)?)/);
    if (!match) continue;
    const time = round3(start + Number(match[1]));
    if (time - start < minShot || end - time < minShot) continue;
    if (cuts.length && time - cuts.at(-1) < minShot) continue;
    cuts.push(time);
  }
  return cuts;
}

async function detectSpeechSegments(sourcePath, { in: start = 0, out, noiseDb = -35, minSilence = 0.45, padding = 0.12, ffmpegPath } = {}) {
  let result;
  try {
    result = await runFfmpeg([
      ...rangeArgs(start, out), "-i", sourcePath,
      "-map", "0:a:0", "-vn", "-sn", "-dn",
      "-af", `silencedetect=n=${noiseDb}dB:d=${minSilence}`,
      "-f", "null", "-",
    ], { ffmpegPath });
  } catch (error) {
    if (error.stderr && NO_AUDIO_PATTERN.test(error.stderr)) throw new Error(NO_AUDIO);
    throw error;
  }
  let end = Number.isFinite(out) ? out : NaN;
  if (!Number.isFinite(end)) {
    // Unknown range end: fall back to the container duration from the input header.
    const match = result.lines.join("\n").match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    end = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : start;
  }

  const silences = [];
  let openStart = null;
  for (const line of result.lines) {
    const startMatch = line.match(/silence_start:\s*(-?\d+(?:\.\d+)?)/);
    const endMatch = line.match(/silence_end:\s*(-?\d+(?:\.\d+)?)/);
    if (startMatch) openStart = Math.max(start, start + Number(startMatch[1]));
    if (endMatch) {
      const silenceEnd = Math.min(end, start + Number(endMatch[1]));
      const silenceStart = openStart ?? start;
      if (silenceEnd > silenceStart) silences.push({ start: round3(silenceStart), end: round3(silenceEnd) });
      openStart = null;
    }
  }
  if (openStart !== null && end > openStart) silences.push({ start: round3(openStart), end: round3(end) });

  const speech = [];
  let cursor = start;
  for (const silence of silences) {
    if (silence.start > cursor) speech.push({ start: cursor, end: silence.start });
    cursor = Math.max(cursor, silence.end);
  }
  if (end > cursor) speech.push({ start: cursor, end });

  const padded = [];
  for (const range of speech) {
    const next = { start: Math.max(start, range.start - padding), end: Math.min(end, range.end + padding) };
    const previous = padded.at(-1);
    if (previous && next.start <= previous.end) previous.end = Math.max(previous.end, next.end);
    else padded.push(next);
  }
  return {
    speech: padded.map((range) => ({ start: round3(range.start), end: round3(range.end) })).filter((range) => range.end > range.start),
    silences,
  };
}

async function extractWaveform(sourcePath, { peaksPerSecond = 50, ffmpegPath } = {}) {
  const sampleRate = 8000;
  const bucketSize = Math.max(1, Math.round(sampleRate / peaksPerSecond));
  const peaks = [];
  let bucketMax = 0;
  let bucketCount = 0;
  let totalSamples = 0;
  let carry = null;
  const onStdout = (chunk) => {
    let data = chunk;
    if (carry) {
      data = Buffer.concat([carry, chunk]);
      carry = null;
    }
    const usable = data.length - (data.length % 2);
    if (usable < data.length) carry = data.subarray(usable);
    for (let offset = 0; offset < usable; offset += 2) {
      const value = Math.abs(data.readInt16LE(offset));
      if (value > bucketMax) bucketMax = value;
      bucketCount += 1;
      if (bucketCount === bucketSize) {
        peaks.push(round3(Math.min(1, bucketMax / 32768)));
        bucketMax = 0;
        bucketCount = 0;
      }
    }
    totalSamples += usable / 2;
  };
  try {
    await runFfmpeg([
      "-i", sourcePath,
      "-map", "0:a:0", "-vn", "-sn", "-dn",
      "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "-",
    ], { ffmpegPath }, onStdout);
  } catch (error) {
    if (error.stderr && NO_AUDIO_PATTERN.test(error.stderr)) return { duration: 0, peaksPerSecond, peaks: [] };
    throw error;
  }
  if (bucketCount > 0) peaks.push(round3(Math.min(1, bucketMax / 32768)));
  return { duration: round3(totalSamples / sampleRate), peaksPerSecond, peaks };
}

async function extractFrame(sourcePath, time, outputJpgPath, { width = 640, ffmpegPath } = {}) {
  await runFfmpeg([
    "-y", "-ss", String(Math.max(0, Number(time) || 0)), "-i", sourcePath,
    "-frames:v", "1", "-vf", `scale=${width}:-2`, "-c:v", "mjpeg", "-q:v", "3",
    "-f", "image2", "-update", "1", outputJpgPath,
  ], { ffmpegPath });
  return outputJpgPath;
}

module.exports = { detectScenes, detectSpeechSegments, extractFrame, extractWaveform };
