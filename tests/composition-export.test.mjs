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
const { resolveFfmpegExecutable } = require("../electron/video-export.cjs");
const { atempoChain, buildCompositionGraph, clipDuration, exportComposition } = require("../electron/composition-export.cjs");
const ffmpeg = resolveFfmpegExecutable();
const ffmpegAvailable = spawnSync(ffmpeg, ["-hide_banner", "-version"], { windowsHide: true }).status === 0;

const quietAudio = { volume: 1, fadeIn: 0, fadeOut: 0, muted: false, effects: [] };
const noAnimation = { type: "none", duration: 0 };

function visual(overrides) {
  return {
    path: "",
    kind: "video",
    start: 0,
    in: 0,
    out: 1,
    speed: 1,
    reverse: false,
    freezeAt: null,
    mirror: false,
    rotate90: 0,
    crop: { x: 0, y: 0, w: 1, h: 1 },
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    adjust: { brightness: 0, contrast: 1, saturation: 1, temperature: 0 },
    effects: [],
    chromaKey: { color: "#00ff00", similarity: 0.3 },
    animationIn: noAnimation,
    animationOut: noAnimation,
    hasAudio: false,
    audio: quietAudio,
    ...overrides,
  };
}

async function ffmpegRun(args) {
  return execFileAsync(ffmpeg, ["-hide_banner", "-y", ...args], { maxBuffer: 64 * 1024 * 1024, encoding: "buffer" });
}

async function probe(file) {
  const { stderr } = await execFileAsync(ffmpeg, ["-hide_banner", "-i", file, "-f", "null", "-"]).catch((error) => error);
  const seconds = stderr.match(/time=(\d+):(\d+):(\d+\.\d+)/g)?.at(-1)?.match(/(\d+):(\d+):(\d+\.\d+)/).slice(1).reduce((sum, part, index) => sum + Number(part) * [3600, 60, 1][index], 0);
  return { stderr, seconds };
}

/** Average RGB of a 5×5 block centred at (x, y) of the frame at time `t`. */
async function pixel(file, t, x, y, width) {
  const { stdout } = await ffmpegRun(["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const sum = [0, 0, 0];
  let count = 0;
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const offset = ((y + dy) * width + (x + dx)) * 3;
      for (let channel = 0; channel < 3; channel += 1) sum[channel] += stdout[offset + channel];
      count += 1;
    }
  }
  return sum.map((value) => Math.round(value / count));
}

test("splits extreme speeds into an atempo chain", () => {
  assert.deepEqual(atempoChain(1), []);
  assert.deepEqual(atempoChain(2), ["atempo=2"]);
  assert.deepEqual(atempoChain(0.2), ["atempo=0.5", "atempo=0.5", "atempo=0.8"]);
  assert.deepEqual(atempoChain(10), ["atempo=2", "atempo=2", "atempo=2", "atempo=1.25"]);
  assert.equal(clipDuration({ kind: "video", in: 1, out: 5, speed: 2 }), 2);
  assert.equal(clipDuration({ kind: "image", in: 0, out: 3, speed: 2 }), 3);
});

test("builds a composition filter graph that follows the contract", () => {
  const graph = buildCompositionGraph({
    width: 1280,
    height: 720,
    fps: 30,
    platform: "youtube",
    duration: 8,
    visuals: [
      visual({ path: "/media/a.mp4", out: 8, hasAudio: true, audio: { volume: 0.5, fadeIn: 1, fadeOut: 0.5, muted: false, effects: ["denoise"] } }),
      visual({
        path: "/media/b.mp4", start: 2, in: 1, out: 5, speed: 2, reverse: true, mirror: true, rotate90: 90,
        crop: { x: 0.1, y: 0, w: 0.8, h: 1 },
        transform: { x: 0.25, y: -0.25, scale: 0.4, rotation: 15, opacity: 0.7 },
        effects: ["bw", "chroma-key"], chromaKey: { color: "#00ff00", similarity: 0.25 },
        animationIn: { type: "zoom-out", duration: 0.5 }, animationOut: { type: "slide-left", duration: 0.5 },
        hasAudio: true, audio: { ...quietAudio, muted: true },
      }),
      visual({ path: "/media/photo.png", kind: "image", start: 1, out: 2 }),
      visual({ path: "/media/loop.gif", kind: "gif", start: 3, in: 0.5, out: 2.5 }),
      visual({ path: "/media/c.mp4", start: 5, out: 2, freezeAt: 1.25, hasAudio: true }),
    ],
    audios: [{ path: "/media/music.m4a", start: 1, in: 2, out: 6, speed: 0.25, audio: { ...quietAudio, effects: ["voice-enhance", "loudnorm"] } }],
    subtitles: [],
    subtitleStyle: {},
  }, { sources: { 2: "/tmp/still-0.jpg" }, assPath: "/tmp/sub.ass" });

  const inputs = graph.inputs.join(" ");
  assert.match(inputs, /-ss 0 -t 8 -i \/media\/a\.mp4/);
  assert.match(inputs, /-ss 1 -t 4 -i \/media\/b\.mp4/);
  assert.match(inputs, /-loop 1 -framerate 30 -t [\d.]+ -i \/tmp\/still-0\.jpg/, "images use the prepared JPEG");
  assert.match(inputs, /-ignore_loop 0 -t [\d.]+ -i \/media\/loop\.gif/);
  assert.match(inputs, /-ss 1\.25 -t 1 -i \/media\/c\.mp4/, "freeze frames seek to freezeAt");
  assert.match(inputs, /-ss 2 -t 4 -i \/media\/music\.m4a/);

  const g = graph.filterGraph;
  assert.match(g, /^color=c=black:s=1280x720:r=30:d=8/);
  assert.match(g, /\[1:v:0\][^\n]*reverse,setpts=PTS\/2,fps=30,trim=duration=2,/);
  assert.match(g, /crop=w='max\(1,floor\(iw\*0\.8\)\)'.*hflip,transpose=clock,scale=w=512:h=288:force_original_aspect_ratio=decrease/);
  assert.match(g, /hue=s=0.*chromakey=color=0x00ff00:similarity=0\.25/);
  assert.match(g, /setpts=PTS\+2\/TB,scale=w='max\(2,trunc\(iw\*\(1\.5-0\.5\*clip\(\(t-2\)\/0\.5,0,1\)\)/);
  assert.match(g, /rotate=a=0\.261799/);
  assert.match(g, /colorchannelmixer=aa=0\.7/);
  assert.match(g, /overlay=x='main_w\/2\+0\.25\*main_w-overlay_w\/2-\(1-clip\(\(4-t\)\/0\.5,0,1\)\)\*main_w'/);
  assert.match(g, /trim=end_frame=1,setpts=PTS-STARTPTS,loop=loop=-1/);
  // Muted and frozen clips contribute no audio; the visible-audio and music clip are mixed without normalisation.
  assert.doesNotMatch(g, /\[1:a:0\]/);
  assert.doesNotMatch(g, /\[4:a:0\]/);
  assert.match(g, /\[0:a:0\][^\n]*afftdn[^\n]*volume=0\.5,afade=t=in:st=0:d=1,afade=t=out:st=7\.5:d=0\.5\[va0\]/);
  assert.match(g, /\[5:a:0\][^\n]*atempo=0\.5,atempo=0\.5,highpass=f=80,acompressor[^\n]*loudnorm[^\n]*adelay=delays=1000:all=1\[aa0\]/);
  assert.match(g, /\[va0\]\[aa0\]amix=inputs=2:duration=longest:normalize=0/);
  assert.match(g, /ass='\/tmp\/sub\.ass'/);
  assert.doesNotMatch(g, /\beq=|hqdn3d|smartblur|boxblur|libx264/);
});

test("exports a layered multi-track composition", { timeout: 300_000, skip: !ffmpegAvailable }, async () => {
  const work = await mkdtemp(path.join(tmpdir(), "dashcut-composition-test-"));
  const red = path.join(work, "red.mp4");
  const keyed = path.join(work, "keyed.mp4");
  const twoTone = path.join(work, "two-tone.mp4");
  const still = path.join(work, "yellow.jpg");
  const gif = path.join(work, "loop.gif");
  const music = path.join(work, "music.m4a");
  const output = path.join(work, "composition.mp4");
  try {
    await ffmpegRun(["-f", "lavfi", "-i", "color=c=red:s=320x180:r=30:d=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-shortest", "-c:v", "mpeg4", "-q:v", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", red]);
    await ffmpegRun(["-f", "lavfi", "-i", "color=c=0x00ff00:s=320x180:r=30:d=6,drawbox=x=110:y=50:w=100:h=80:color=blue:t=fill", "-c:v", "mpeg4", "-q:v", "2", "-pix_fmt", "yuv420p", keyed]);
    await ffmpegRun(["-f", "lavfi", "-i", "color=c=magenta:s=320x180:r=30:d=1[a];color=c=cyan:s=320x180:r=30:d=1[b];[a][b]concat=n=2:v=1:a=0[out0]", "-c:v", "mpeg4", "-q:v", "2", "-pix_fmt", "yuv420p", twoTone]);
    await ffmpegRun(["-f", "lavfi", "-i", "color=c=yellow:s=300x400:d=1", "-frames:v", "1", "-c:v", "mjpeg", "-pix_fmt", "yuvj420p", still]);
    await ffmpegRun(["-f", "lavfi", "-i", "testsrc=s=160x120:r=10:d=0.5", "-c:v", "gif", gif]);
    await ffmpegRun(["-f", "lavfi", "-i", "sine=frequency=880:duration=4", "-c:a", "aac", music]);

    const width = 640;
    const height = 360;
    const prepared = [];
    const progress = [];
    const request = {
      width,
      height,
      fps: 30,
      platform: "youtube",
      duration: 6,
      visuals: [
        visual({ path: red, out: 6, hasAudio: true, audio: { ...quietAudio, volume: 0.8 } }),
        visual({
          path: keyed, start: 0.5, in: 0, out: 5, mirror: true, rotate90: 90,
          crop: { x: 0.1, y: 0, w: 0.8, h: 1 },
          transform: { x: 0.25, y: -0.25, scale: 0.4, rotation: 15, opacity: 0.7 },
          adjust: { brightness: 0.05, contrast: 1.1, saturation: 1.2, temperature: 0.1 },
          effects: ["chroma-key", "sharpen"], chromaKey: { color: "#00ff00", similarity: 0.3 },
          animationIn: { type: "fade", duration: 0.5 }, animationOut: { type: "slide-right", duration: 0.5 },
        }),
        visual({ path: still, kind: "image", start: 1, in: 0, out: 1.5, transform: { x: -0.3, y: 0.25, scale: 0.3, rotation: 0, opacity: 1 } }),
        visual({ path: gif, kind: "gif", start: 2.5, in: 0.2, out: 1.4, transform: { x: 0.3, y: 0.3, scale: 0.25, rotation: 0, opacity: 1 }, animationIn: { type: "zoom-in", duration: 0.4 } }),
        visual({ path: twoTone, start: 3.5, in: 0, out: 2, speed: 2, reverse: true, transform: { x: -0.3, y: -0.25, scale: 0.3, rotation: 0, opacity: 1 } }),
        visual({ path: twoTone, start: 4.6, in: 0, out: 1, freezeAt: 0.5, transform: { x: 0.3, y: 0.25, scale: 0.3, rotation: 0, opacity: 1 } }),
      ],
      audios: [{ path: music, start: 1, in: 0, out: 3, speed: 1, audio: { volume: 0.6, fadeIn: 0.5, fadeOut: 0.5, muted: false, effects: ["voice-enhance"] } }],
      subtitles: [{ start: 0.2, end: 1.2, zh: "多轨合成", en: "Composition" }],
      subtitleStyle: { fontFamily: "Arial", fontSize: 34, color: "#ffffff", outlineColor: "#000000", outlineWidth: 2 },
    };
    const result = await exportComposition(request, {
      outputPath: output,
      tempPath: work,
      ffmpegPath: ffmpeg,
      platform: process.platform,
      onProgress: (item) => progress.push(item.progress),
      prepareStill: async (source) => { prepared.push(source); return source; },
    });
    assert.equal(result.outputPath, output);
    assert.equal(result.duration, 6);
    assert.deepEqual(prepared, [still]);
    assert.equal(progress.at(-1), 100);
    assert.ok((await stat(output)).size > 10_000);
    await Promise.all([access(path.join(work, "composition.zh.srt")), access(path.join(work, "composition.en.srt"))]);
    assert.match(await readFile(path.join(work, "composition.zh.srt"), "utf8"), /多轨合成/);

    const { stderr, seconds } = await probe(output);
    assert.ok(Math.abs(seconds - 6) <= 0.15, `expected ~6s, got ${seconds}`);
    assert.match(stderr, /Video: h264/);
    assert.match(stderr, /Audio: aac.*48000 Hz, stereo/);
    const { stderr: errors } = await execFileAsync(ffmpeg, ["-hide_banner", "-v", "error", "-i", output, "-f", "null", "-"]);
    assert.equal(String(errors).trim(), "");

    const isNear = (actual, expected, tolerance = 60) => actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);
    // Bottom track fills the canvas with red where nothing is stacked above.
    const background = await pixel(output, 3, 60, 340, width);
    assert.ok(isNear(background, [255, 0, 0]), `background ${background}`);
    // Still image centred at (W/2 - 0.3W, H/2 + 0.25H) while on the timeline, gone afterwards.
    assert.ok(isNear(await pixel(output, 1.8, 128, 270, width), [255, 255, 0]), "yellow still visible at 1.8s");
    assert.ok(isNear(await pixel(output, 3, 128, 270, width), [255, 0, 0]), "still removed after its range");
    // Keyed overlay: blue box at 70 % opacity over red; the green screen around it is transparent.
    const keyedCentre = await pixel(output, 3, 480, 90, width);
    assert.ok(keyedCentre[2] > 120 && keyedCentre[0] > 40 && keyedCentre[0] < 160 && keyedCentre[1] < 60, `keyed centre ${keyedCentre}`);
    const keyedEdge = await pixel(output, 3, 480, 40, width);
    assert.ok(isNear(keyedEdge, [255, 0, 0], 70), `green screen keyed out ${keyedEdge}`);
    // 2× reversed clip starts from the end of the source (cyan), placed at (W/2 - 0.3W, H/2 - 0.25H).
    assert.ok(isNear(await pixel(output, 3.6, 128, 90, width), [0, 255, 255]), "reversed clip starts on its last frames");
    assert.ok(isNear(await pixel(output, 4.4, 128, 90, width), [255, 0, 255]), "reversed clip ends on its first frames");
    // Freeze frame holds the magenta frame at 0.5 s of the source.
    assert.ok(isNear(await pixel(output, 5.4, 512, 270, width), [255, 0, 255]), "freeze frame shows source frame at freezeAt");
    assert.ok(isNear(await pixel(output, 5.4, 128, 90, width), [255, 0, 0]), "reversed clip removed after its range");

    const { stderr: volume } = await execFileAsync(ffmpeg, ["-hide_banner", "-i", output, "-af", "volumedetect", "-f", "null", "-"]);
    const maxVolume = Number(volume.match(/max_volume: (-?[\d.]+) dB/)?.[1]);
    assert.ok(maxVolume > -20, `expected audible mix, got ${maxVolume} dB`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("exports a silent AAC track when no clip has audio", { timeout: 120_000, skip: !ffmpegAvailable }, async () => {
  const work = await mkdtemp(path.join(tmpdir(), "dashcut-composition-silent-"));
  const still = path.join(work, "still.jpg");
  const mute = path.join(work, "no-audio.mp4");
  const output = path.join(work, "silent.mp4");
  try {
    await ffmpegRun(["-f", "lavfi", "-i", "testsrc=s=320x240:d=1", "-frames:v", "1", "-c:v", "mjpeg", "-pix_fmt", "yuvj420p", still]);
    await ffmpegRun(["-f", "lavfi", "-i", "testsrc=s=320x240:r=30:d=1", "-c:v", "mpeg4", "-pix_fmt", "yuv420p", mute]);
    await exportComposition({
      width: 640,
      height: 360,
      fps: 30,
      platform: "bilibili",
      duration: 2,
      // hasAudio is stale here: the file has no audio stream, which must not break the export.
      visuals: [visual({ path: still, kind: "image", out: 2 }), visual({ path: mute, start: 0.5, out: 1, hasAudio: true, transform: { x: 0, y: 0, scale: 0.5, rotation: 0, opacity: 1 } })],
      audios: [],
      subtitles: [],
      subtitleStyle: {},
    }, { outputPath: output, tempPath: work, ffmpegPath: ffmpeg, platform: process.platform });
    const { stderr, seconds } = await probe(output);
    assert.ok(Math.abs(seconds - 2) <= 0.15, `expected ~2s, got ${seconds}`);
    assert.match(stderr, /Audio: aac.*48000 Hz, stereo/);
    const { stderr: volume } = await execFileAsync(ffmpeg, ["-hide_banner", "-i", output, "-map", "0:a", "-af", "volumedetect", "-f", "null", "-"]);
    assert.match(volume, /max_volume: -(inf|9\d(\.\d+)?) dB/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
