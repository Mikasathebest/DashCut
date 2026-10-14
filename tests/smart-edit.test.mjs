import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import test, { after, before } from "node:test";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const { resolveFfmpegExecutable } = require("../electron/video-export.cjs");
const { detectScenes, detectSpeechSegments, extractFrame, extractWaveform } = require("../electron/smart-edit.cjs");
const ffmpeg = resolveFfmpegExecutable();
const ffmpegAvailable = spawnSync(ffmpeg, ["-hide_banner", "-version"], { windowsHide: true }).status === 0;
const skip = !ffmpegAvailable;

let work = "";
let scenes = "";
let speech = "";

async function makeFixture(args, output) {
  await execFileAsync(ffmpeg, ["-hide_banner", "-y", ...args, output]);
  return output;
}

before(async () => {
  if (skip) return;
  work = await mkdtemp(path.join(tmpdir(), "dashcut-smart-edit-test-"));
  // Silent video: red 1.5s / blue 1.5s / green 1.5s -> cuts near 1.5 and 3.0.
  scenes = await makeFixture([
    "-f", "lavfi", "-i", "color=c=red:s=320x180:d=1.5:r=25",
    "-f", "lavfi", "-i", "color=c=blue:s=320x180:d=1.5:r=25",
    "-f", "lavfi", "-i", "color=c=green:s=320x180:d=1.5:r=25",
    "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0",
    "-c:v", "mpeg4", "-q:v", "4", "-pix_fmt", "yuv420p",
  ], path.join(work, "scenes.mp4"));
  // Video + audio: tone 1s / silence 1s / tone 1s.
  speech = await makeFixture([
    "-f", "lavfi", "-i", "color=c=0x315c78:s=320x180:d=3:r=25",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=44100",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=44100",
    "-filter_complex", "[1][2][3]concat=n=3:v=0:a=1[a]",
    "-map", "0:v", "-map", "[a]",
    "-c:v", "mpeg4", "-q:v", "4", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le",
  ], path.join(work, "speech.mov"));
});

after(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ~${expected}, got ${actual}`);

test("detects scene cuts in absolute source seconds", { timeout: 60_000, skip }, async () => {
  const cuts = await detectScenes(scenes, { ffmpegPath: ffmpeg, out: 4.5 });
  assert.equal(cuts.length, 2, JSON.stringify(cuts));
  near(cuts[0], 1.5, 0.1, "first cut");
  near(cuts[1], 3.0, 0.1, "second cut");

  const offset = await detectScenes(scenes, { ffmpegPath: ffmpeg, in: 0.8, out: 3.9 });
  assert.equal(offset.length, 2, JSON.stringify(offset));
  near(offset[0], 1.5, 0.1, "offset first cut");
  near(offset[1], 3.0, 0.1, "offset second cut");

  // A cut within minShot of the range edge is dropped.
  const edge = await detectScenes(scenes, { ffmpegPath: ffmpeg, in: 1.2, out: 2.5 });
  assert.deepEqual(edge, []);
});

test("finds speech ranges around pauses with padding", { timeout: 60_000, skip }, async () => {
  const result = await detectSpeechSegments(speech, { ffmpegPath: ffmpeg, in: 0, out: 3 });
  assert.equal(result.silences.length, 1, JSON.stringify(result));
  near(result.silences[0].start, 1, 0.05, "silence start");
  near(result.silences[0].end, 2, 0.05, "silence end");
  assert.equal(result.speech.length, 2, JSON.stringify(result));
  near(result.speech[0].start, 0, 0.001, "speech 1 start (clamped)");
  near(result.speech[0].end, 1.12, 0.05, "speech 1 end");
  near(result.speech[1].start, 1.88, 0.05, "speech 2 start");
  near(result.speech[1].end, 3, 0.001, "speech 2 end (clamped)");

  // Without `out`, the container duration bounds the result.
  const whole = await detectSpeechSegments(speech, { ffmpegPath: ffmpeg });
  assert.equal(whole.speech.length, 2);
  near(whole.speech[1].end, 3, 0.05, "whole speech end");
});

test("handles in/out offsets and trailing silence", { timeout: 60_000, skip }, async () => {
  // [0.5, 1.8): tone until 1.0, then silence with no silence_end before the range ends.
  const trailing = await detectSpeechSegments(speech, { ffmpegPath: ffmpeg, in: 0.5, out: 1.8 });
  assert.equal(trailing.silences.length, 1, JSON.stringify(trailing));
  near(trailing.silences[0].start, 1, 0.05, "trailing silence start");
  near(trailing.silences[0].end, 1.8, 0.001, "trailing silence end");
  assert.equal(trailing.speech.length, 1);
  near(trailing.speech[0].start, 0.5, 0.001, "offset speech start");
  near(trailing.speech[0].end, 1.12, 0.05, "offset speech end");

  // Large padding merges both speech ranges into one.
  const merged = await detectSpeechSegments(speech, { ffmpegPath: ffmpeg, in: 0, out: 3, padding: 0.6 });
  assert.deepEqual(merged.speech, [{ start: 0, end: 3 }]);
});

test("rejects smart talking-head cut on video without audio", { timeout: 60_000, skip }, async () => {
  await assert.rejects(detectSpeechSegments(scenes, { ffmpegPath: ffmpeg }), { message: "该片段没有音频，无法智能剪口播" });
});

test("extracts a normalized waveform", { timeout: 60_000, skip }, async () => {
  const waveform = await extractWaveform(speech, { ffmpegPath: ffmpeg, peaksPerSecond: 20 });
  assert.equal(waveform.peaksPerSecond, 20);
  near(waveform.duration, 3, 0.05, "duration");
  near(waveform.peaks.length, 60, 2, "peak count");
  assert.ok(waveform.peaks.every((peak) => peak >= 0 && peak <= 1));
  const loud = waveform.peaks.slice(2, 18);
  const silent = waveform.peaks.slice(22, 38);
  assert.ok(Math.min(...loud) > 0.05, `loud buckets: ${loud}`);
  assert.ok(Math.max(...silent) < 0.01, `silent buckets: ${silent}`);

  assert.deepEqual(await extractWaveform(scenes, { ffmpegPath: ffmpeg }), { duration: 0, peaksPerSecond: 50, peaks: [] });
});

test("extracts a decodable JPEG frame", { timeout: 60_000, skip }, async () => {
  const output = path.join(work, "frame.jpg");
  assert.equal(await extractFrame(scenes, 2.2, output, { ffmpegPath: ffmpeg, width: 160 }), output);
  const bytes = await readFile(output);
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8);
  const { stderr } = await execFileAsync(ffmpeg, ["-hide_banner", "-i", output, "-f", "null", "-"]).catch((error) => error);
  assert.match(stderr, /mjpeg.*160x90/);
});

test("reports a missing FFmpeg runtime in Chinese", async () => {
  await assert.rejects(extractFrame("in.mp4", 0, "out.jpg", { ffmpegPath: path.join(tmpdir(), "dashcut-missing-ffmpeg") }), { message: "安装包缺少 LGPL FFmpeg 运行时，请重新安装 DashCut 极剪" });
});
