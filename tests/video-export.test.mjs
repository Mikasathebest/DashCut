import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import test from "node:test";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const { createAss, createSrt, exportVideo, resolveFfmpegExecutable, videoEncoderArgs } = require("../electron/video-export.cjs");
const ffmpeg = resolveFfmpegExecutable();
const ffmpegAvailable = spawnSync(ffmpeg, ["-hide_banner", "-version"], { windowsHide: true }).status === 0;

test("generates ASS and SRT from real subtitle data", () => {
  const subtitles = [{ start: 0, end: 1.25, zh: "你好", en: "Hello" }];
  const ass = createAss(subtitles, { fontFamily: "Arial", fontSize: 34, color: "#ffffff", outlineColor: "#000000", outlineWidth: 2 }, 1280, 720);
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:01\.25/);
  assert.match(ass, /你好\\N\{\\fs[\d.]+\\c&H00[0-9A-F]{6}&\}Hello/);
  assert.match(createAss(subtitles, {}, 1280, 720, "zh"), /,,你好\n/);
  assert.match(createAss(subtitles, { order: "en-first" }, 1280, 720), /,,\{\\c&H[0-9A-F]{8}&\}Hello\\N\{\\fs[\d.]+\}你好/);
  // A background box switches libass to BorderStyle 3; position top uses alignment 8.
  assert.match(createAss(subtitles, { backgroundOpacity: 60, position: "top", offset: 10 }, 1280, 720), /,-1,0,0,0,100,100,0,0,3,[\d.]+,0,8,80,80,72,1/);
  assert.match(createSrt(subtitles, "en"), /00:00:00,000 --> 00:00:01,250\nHello/);
});

test("selects LGPL platform H.264 encoders", () => {
  const settings = { width: 1920, height: 1080, fps: 60, destination: "youtube", finalPass: true };
  assert.equal(videoEncoderArgs("darwin", settings)[1], "h264_videotoolbox");
  assert.equal(videoEncoderArgs("win32", settings)[1], "h264_mf");
  assert.match(videoEncoderArgs("win32", settings).join(" "), /-hw_encoding 1/);
  assert.match(videoEncoderArgs("win32", { ...settings, hardware: false }).join(" "), /-hw_encoding 0/);
  assert.doesNotMatch(videoEncoderArgs("darwin", settings).join(" "), /libx264|nonfree/);
});

test("exports a playable MP4 with burned subtitles and SRT sidecars", { timeout: 120_000, skip: !ffmpegAvailable }, async () => {
  const work = await mkdtemp(path.join(tmpdir(), "dashcut-export-test-"));
  const source = path.join(work, "source.mp4");
  const output = path.join(work, "output.mp4");
  try {
    await execFileAsync(ffmpeg, [
      "-hide_banner", "-y",
      "-f", "lavfi", "-i", "color=c=0x315c78:s=320x180:d=1.2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1.2",
      "-shortest", "-c:v", "mpeg4", "-q:v", "4", "-pix_fmt", "yuv420p", "-c:a", "aac", source,
    ]);
    const progress = [];
    const result = await exportVideo({
      segments: [{ path: source, sourceStart: 0, sourceEnd: 1.1 }],
      subtitles: [{ start: 0.1, end: 0.9, zh: "真实字幕", en: "Real caption" }],
      subtitleStyle: { fontFamily: "Arial", fontSize: 34, color: "#ffffff", outlineColor: "#000000", outlineWidth: 2 },
      musicPath: "",
      musicVolume: 0.35,
      fps: 30,
      resolution: 720,
      platform: "youtube",
    }, { outputPath: output, tempPath: work, ffmpegPath: ffmpeg, platform: process.platform, onProgress: (item) => progress.push(item.progress) });
    assert.equal(result.outputPath, output);
    assert.ok((await stat(output)).size > 10_000);
    await execFileAsync(ffmpeg, ["-hide_banner", "-v", "error", "-i", output, "-f", "null", "-"]);
    await Promise.all([access(path.join(work, "output.zh.srt")), access(path.join(work, "output.en.srt"))]);
    assert.match(await readFile(path.join(work, "output.zh.srt"), "utf8"), /真实字幕/);
    assert.equal(progress.at(-1), 100);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("exports mixed video, still image and looping GIF segments", { timeout: 180_000, skip: !ffmpegAvailable }, async () => {
  const work = await mkdtemp(path.join(tmpdir(), "dashcut-mixed-test-"));
  const video = path.join(work, "clip.mp4");
  const still = path.join(work, "photo.jpg");
  const gif = path.join(work, "loop.gif");
  const output = path.join(work, "mixed.mp4");
  try {
    await execFileAsync(ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=0x315c78:s=320x180:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-shortest", "-c:v", "mpeg4", "-pix_fmt", "yuv420p", "-c:a", "aac", video]);
    await execFileAsync(ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc=s=301x401:d=1", "-frames:v", "1", "-c:v", "mjpeg", "-pix_fmt", "yuvj420p", still]);
    await execFileAsync(ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc=s=160x120:r=10:d=0.5", "-c:v", "gif", gif]);
    const prepared = [];
    await exportVideo({
      segments: [
        { path: video, kind: "video", sourceStart: 0, sourceEnd: 1 },
        { path: still, kind: "image", sourceStart: 0, sourceEnd: 1.5 },
        { path: gif, kind: "gif", sourceStart: 0.2, sourceEnd: 1.4 },
      ],
      subtitles: [],
      subtitleStyle: {},
      musicPath: "",
      musicVolume: 0.35,
      fps: 30,
      resolution: 720,
      platform: "youtube",
    }, { outputPath: output, tempPath: work, ffmpegPath: ffmpeg, platform: process.platform, prepareStill: async (source) => { prepared.push(source); return source; } });
    assert.deepEqual(prepared, [still]);
    const { stderr } = await execFileAsync(ffmpeg, ["-hide_banner", "-i", output, "-f", "null", "-"]).catch((error) => error);
    const seconds = stderr.match(/time=(\d+):(\d+):(\d+\.\d+)/g)?.at(-1)?.match(/(\d+):(\d+):(\d+\.\d+)/).slice(1).reduce((sum, part, index) => sum + Number(part) * [3600, 60, 1][index], 0);
    assert.ok(Math.abs(seconds - 3.7) < 0.25, `expected ~3.7s, got ${seconds}`);
    assert.match(stderr, /Audio: aac/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
