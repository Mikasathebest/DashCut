import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  atempoChain, findVoiceForLanguage, fitLine, listVoices, normalizeLanguage, parseMacVoices, parseWindowsVoices, renderDub, synthesizeLine,
} = require("../electron/dubbing.cjs");
const { resolveFfmpegExecutable } = require("../electron/video-export.cjs");

const ffmpeg = resolveFfmpegExecutable();
const ffmpegAvailable = spawnSync(ffmpeg, ["-hide_banner", "-version"], { windowsHide: true }).status === 0;
const macSpeech = process.platform === "darwin" && spawnSync("say", ["-v", "?"], { windowsHide: true }).status === 0;
const skipMac = !(macSpeech && ffmpegAvailable) && "needs macOS say and FFmpeg";

function probe(file) {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-nostdin", "-i", file, "-af", "silencedetect=noise=-40dB:d=0.25", "-f", "null", "-"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const stream = result.stderr.match(/Stream #0:0.*Audio: (\w+).*?(\d+) Hz, (\w+)/);
  const times = [...result.stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const [, h, m, s] = times[times.length - 1];
  const silenceStarts = [...result.stderr.matchAll(/silence_start: (-?[\d.]+)/g)].map((match) => Number(match[1]));
  const silenceEnds = [...result.stderr.matchAll(/silence_end: ([\d.]+)/g)].map((match) => Number(match[1]));
  return { codec: stream?.[1], rate: Number(stream?.[2]), layout: stream?.[3], duration: Number(h) * 3600 + Number(m) * 60 + Number(s), silenceStarts, silenceEnds };
}

test("fitLine never slows down and keeps short lines at 1x", () => {
  assert.deepEqual(fitLine(1.2, 3, 1.6), { speedup: 1, duration: 1.2, overflow: 0 });
  assert.deepEqual(fitLine(3, 3, 1.6), { speedup: 1, duration: 3, overflow: 0 });
});

test("fitLine speeds up just enough to fill the slot", () => {
  const fit = fitLine(4, 3, 1.6);
  assert.ok(Math.abs(fit.speedup - 4 / 3) < 1e-9);
  assert.ok(Math.abs(fit.duration - 3) < 1e-9);
  assert.equal(fit.overflow, 0);
});

test("fitLine caps speedup and reports overflow instead of truncating", () => {
  const fit = fitLine(5, 2, 1.6);
  assert.equal(fit.speedup, 1.6);
  assert.ok(Math.abs(fit.duration - 3.125) < 1e-9);
  assert.ok(Math.abs(fit.overflow - 1.125) < 1e-9);
  const zero = fitLine(2, 0, 1.5);
  assert.equal(zero.speedup, 1.5);
  assert.ok(zero.overflow > 1.3);
  assert.deepEqual(fitLine(0, 2), { speedup: 1, duration: 0, overflow: 0 });
});

test("atempoChain splits large factors and omits unity", () => {
  assert.deepEqual(atempoChain(1), []);
  assert.deepEqual(atempoChain(1.25), ["atempo=1.25000"]);
  assert.deepEqual(atempoChain(3), ["atempo=2", "atempo=1.50000"]);
});

test("parses macOS and Windows voice listings", () => {
  const mac = parseMacVoices([
    "Tingting            zh_CN    # 你好，我叫婷婷。",
    "Eddy (Chinese (China mainland)) zh_CN    # 你好！我叫Eddy。",
    "Bad News            en_US    # Hello! My name is Bad News.",
    "Reed (English (UK)) en_GB    # Hello! My name is Reed.",
    "Majed               ar_001   # مرحبًا!",
    "",
  ].join("\n"));
  assert.deepEqual(mac.map((voice) => [voice.name, voice.language]), [
    ["Tingting", "zh-CN"], ["Eddy (Chinese (China mainland))", "zh-CN"], ["Bad News", "en-US"], ["Reed (English (UK))", "en-GB"], ["Majed", "ar-001"],
  ]);
  const win = parseWindowsVoices("Microsoft Huihui Desktop|zh-CN\r\nMicrosoft Zira Desktop|en-US\r\n");
  assert.deepEqual(win, [
    { id: "Microsoft Huihui Desktop", name: "Microsoft Huihui Desktop", language: "zh-CN" },
    { id: "Microsoft Zira Desktop", name: "Microsoft Zira Desktop", language: "en-US" },
  ]);
  assert.equal(normalizeLanguage("zh_cn"), "zh-CN");
  assert.equal(findVoiceForLanguage(win, "zh")?.name, "Microsoft Huihui Desktop");
  assert.equal(findVoiceForLanguage(win, "en-GB")?.name, "Microsoft Zira Desktop");
  assert.equal(findVoiceForLanguage(win, "ja-JP"), null);
});

test("unsupported platforms have no voices and fail with a clear error", async () => {
  assert.deepEqual(await listVoices({ platform: "linux" }), []);
  await assert.rejects(
    renderDub({ lines: [{ start: 0, end: 1, text: "hi" }], language: "ja-JP", platform: "linux", outputPath: path.join(tmpdir(), "never.wav") }),
    /系统没有可用的 ja-JP 语音/,
  );
});

test("lists English and Chinese voices on macOS", { skip: !macSpeech && "needs macOS say" }, async () => {
  const voices = await listVoices({ platform: "darwin" });
  assert.ok(voices.some((voice) => voice.language.startsWith("en-")), "no English voice");
  assert.ok(voices.some((voice) => voice.language.startsWith("zh-")), "no Chinese voice");
});

test("synthesizeLine writes decodable audio", { skip: skipMac }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dashcut-dub-test-"));
  try {
    const voices = await listVoices({ platform: "darwin" });
    const zh = findVoiceForLanguage(voices, "zh-CN");
    const outputPath = path.join(dir, "line.aiff");
    await synthesizeLine({ text: "-v 你好，这是离线配音测试。", voice: zh.id, rate: 200, outputPath, platform: "darwin" });
    const info = probe(outputPath);
    assert.equal(info.rate, 48000);
    assert.ok(info.duration > 0.5, `duration ${info.duration}`);
    await assert.rejects(synthesizeLine({ text: "  ", outputPath, platform: "darwin" }), /语音合成失败/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renderDub aligns lines, speeds up long lines and cleans its temp dir", { skip: skipMac }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dashcut-dub-test-"));
  try {
    const tempPath = path.join(dir, "tmp");
    const outputPath = path.join(dir, "dub.wav");
    const lines = [
      { start: 0.5, end: 2.5, text: "Hello there." },
      { start: 3, end: 4.5, text: "This sentence is deliberately too long to fit into the short slot it was given." },
      { start: 4.5, end: 5, text: "   " },
      { start: 6, end: 7.5, text: "Goodbye." },
    ];
    const progress = [];
    const result = await renderDub({ lines, language: "en-US", platform: "darwin", outputPath, tempPath, onProgress: (value) => progress.push(value) });
    assert.equal(result.outputPath, outputPath);
    assert.equal(result.lines.length, 3);
    assert.equal(result.lines[0].speedup, 1);
    assert.ok(result.lines[1].speedup > 1, `speedup ${result.lines[1].speedup}`);
    assert.ok(result.lines[1].speedup <= 1.6 + 1e-9);
    // Slot runs to the next spoken line (6 s): empty lines are skipped, not slot boundaries.
    assert.ok(result.lines[1].spoken <= 3 + result.lines[1].overflow + 0.05);
    assert.ok(progress.length > 2 && progress[progress.length - 1] === 1);
    assert.ok(progress.every((value, index) => value >= 0 && value <= 1 && (index === 0 || value >= progress[index - 1])));

    const info = probe(outputPath);
    assert.equal(info.codec, "pcm_s16le");
    assert.equal(info.rate, 48000);
    assert.equal(info.layout, "stereo");
    assert.ok(Math.abs(info.duration - result.duration) < 0.05, `${info.duration} vs ${result.duration}`);
    assert.ok(Math.abs(info.duration - Math.max(7.5, 6 + result.lines[2].spoken)) < 0.1, `duration ${info.duration}`);

    // Speech must begin close to each line's start. The long line is sped up to fill
    // its slot exactly, so the last line abuts it: check it is voiced, not gap-separated.
    const silences = info.silenceStarts.map((start, index) => [start, info.silenceEnds[index] ?? info.duration]);
    const silentAt = (time) => silences.some(([from, to]) => time >= from && time <= to);
    assert.ok(silentAt(0.1), "track should open with silence");
    for (const start of [0.5, 3]) {
      assert.ok(info.silenceEnds.some((end) => end >= start - 0.05 && end <= start + 0.35), `no speech onset near ${start}: ${info.silenceEnds}`);
    }
    for (const start of [0.5, 3, 6]) assert.ok(!silentAt(start + 0.3), `silent at ${start + 0.3}`);
    assert.ok(silentAt(2.5) && silentAt(info.duration - 0.2), "gaps between lines should be silent");

    assert.deepEqual(await readdir(tempPath), [], "temp dir not cleaned");
    assert.ok((await stat(outputPath)).size > 7.5 * 48000 * 4 * 0.95);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
