import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import test from "node:test";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const { resolveFfmpegExecutable } = require("../electron/video-export.cjs");
const { analyzeComposition, atempoChain, buildCompositionGraph, clipDuration, exportComposition, keyframeExpression, keyframeValue, normalizeOutput, parseEbur128Summary, parseLoudnormJson, parseSilences } = require("../electron/composition-export.cjs");
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

/** Evaluates a generated FFmpeg keyframe expression in JS (it only uses if/lt/clip and arithmetic). */
function evaluateExpression(expression, t) {
  assert.match(expression, /^[\d.t()+\-*/,a-z]*$/, `unexpected tokens in ${expression}`);
  const iff = (condition, whenTrue, whenFalse) => (condition ? whenTrue : whenFalse);
  const lt = (a, b) => (a < b ? 1 : 0);
  const clip = (value, min, max) => Math.min(max, Math.max(min, value));
  const scope = { t, iff, lt, clip };
  const tokens = expression.replace(/\bif\(/g, "iff(").match(/\d+(?:\.\d+)?|[a-z]+|[()+\-*/,]/g);
  let index = 0;
  const peek = () => tokens[index];
  const next = () => tokens[index++];
  const parseExpression = () => {
    let value = parseTerm();
    while (peek() === "+" || peek() === "-") value = next() === "+" ? value + parseTerm() : value - parseTerm();
    return value;
  };
  const parseTerm = () => {
    let value = parseFactor();
    while (peek() === "*" || peek() === "/") value = next() === "*" ? value * parseFactor() : value / parseFactor();
    return value;
  };
  const parseFactor = () => {
    const token = next();
    if (token === "-") return -parseFactor();
    if (token === "(") {
      const value = parseExpression();
      next();
      return value;
    }
    if (/^\d/.test(token)) return Number(token);
    if (peek() === "(") {
      next();
      const args = [parseExpression()];
      while (peek() === ",") {
        next();
        args.push(parseExpression());
      }
      next();
      return scope[token](...args);
    }
    return scope[token];
  };
  return parseExpression();
}

test("keyframe expressions follow each easing between points and hold outside them", () => {
  const easings = {
    linear: (p) => p,
    "ease-in": (p) => p * p,
    "ease-out": (p) => 1 - (1 - p) * (1 - p),
    "ease-in-out": (p) => (p < 0.5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p)),
    hold: () => 0,
  };
  for (const [easing, curve] of Object.entries(easings)) {
    const points = [{ time: 2, value: 30, easing: "linear" }, { time: 0, value: 10, easing }];
    const expression = keyframeExpression(points, "t");
    for (const t of [-1, 0, 0.3, 0.5, 1, 1.4, 1.9, 2, 5]) {
      const expected = t <= 0 ? 10 : t >= 2 ? 30 : 10 + 20 * curve(t / 2);
      assert.ok(Math.abs(evaluateExpression(expression, t) - expected) < 1e-4, `${easing} expression at ${t}`);
      assert.ok(Math.abs(keyframeValue(points, t) - expected) < 1e-9, `${easing} reference at ${t}`);
    }
  }
  const multi = [{ time: 0, value: 0, easing: "hold" }, { time: 1, value: 1, easing: "ease-in" }, { time: 3, value: -1, easing: "linear" }];
  const expression = keyframeExpression(multi, "(t-2)");
  assert.equal(evaluateExpression(expression, 2.5), 0, "hold keeps the left value");
  assert.equal(evaluateExpression(expression, 3), 1);
  assert.ok(Math.abs(evaluateExpression(expression, 4) - (1 - 2 * 0.25)) < 1e-6, "ease-in on the second segment");
  assert.equal(evaluateExpression(expression, 9), -1);
  assert.equal(keyframeExpression([{ time: 1, value: 0.5, easing: "linear" }], "t"), "0.5");
  assert.equal(keyframeExpression([], "t"), undefined);
});

test("graph wires keyframes, wipes, volume keyframes and RGBA layers", () => {
  const graph = buildCompositionGraph({
    width: 640,
    height: 360,
    fps: 30,
    duration: 4,
    visuals: [
      visual({
        path: "/media/a.mp4", start: 1, out: 3,
        keyframes: { x: [{ time: 0, value: -0.2, easing: "linear" }, { time: 1, value: 0.2, easing: "linear" }], opacity: [{ time: 0, value: 0, easing: "ease-in" }, { time: 1, value: 1, easing: "linear" }] },
        animationIn: { type: "wipe-right", duration: 0.5 }, animationOut: { type: "wipe-left", duration: 0.5 },
        hasAudio: true, audio: { ...quietAudio, volume: 0.3, volumeKeyframes: [{ time: 0, value: 0, easing: "linear" }, { time: 1, value: 1, easing: "linear" }] },
      }),
      visual({ path: "/media/title.rgba", kind: "rgba", rgba: { width: 64, height: 32 }, out: 2, speed: 3, transform: { x: 0, y: 0, scale: 0.5, rotation: 30, opacity: 0.5 }, keyframes: { rotation: [{ time: 0, value: 0, easing: "linear" }, { time: 1, value: 90, easing: "linear" }], scale: [{ time: 0, value: 0.2, easing: "linear" }, { time: 1, value: 0.8, easing: "linear" }] } }),
    ],
    audios: [],
    subtitles: [],
    subtitleStyle: {},
  });
  assert.match(graph.inputs.join(" "), /-f rawvideo -pix_fmt rgba -video_size 64x32 -framerate 30 -i \/media\/title\.rgba/);
  assert.equal(clipDuration({ kind: "rgba", in: 0, out: 2, speed: 3 }), 2, "RGBA stills ignore speed");
  const g = graph.filterGraph;
  assert.match(g, /overlay=x='main_w\/2\+\(if\(lt\(\(t-1\),0\),-0\.2,/);
  assert.match(g, /split\[kc0\]\[ka0\];\[ka0\]alphaextract,geq=lum='if\(eq\(X,0\),st\(0,clip\(if\(lt\(\(T-1\),0\),0,[^']*\)\+st\(1,clip\(\(T-1\)\/0\.5,0,1\)\)\+st\(2,clip\(\(4-T\)\/0\.5,0,1\)\),0\);p\(X,Y\)\*ld\(0\)\*lt\(X,W\*ld\(1\)\)\*gte\(X,W\*\(1-ld\(2\)\)\)'\[km0\];\[kc0\]\[km0\]alphamerge,format=rgba/);
  assert.doesNotMatch(g.split("\n")[1], /colorchannelmixer/, "opacity keyframes replace the static opacity");
  assert.match(g, /volume=eval=frame:volume='clip\(if\(lt\(t,0\),0,/);
  assert.doesNotMatch(g, /volume=0\.3/);
  assert.match(g, /\[1:v:0\]trim=end_frame=1,setpts=PTS-STARTPTS,loop=loop=-1:size=1:start=0,fps=30,trim=duration=2,/);
  assert.match(g, /scale=w=512:h=288:force_original_aspect_ratio=decrease/, "keyframed scale fits at its maximum");
  assert.match(g, /scale=w='max\(2,trunc\(iw\*\(clip\(if\(lt\(\(t-0\),0\),0\.2,[^']*,0\.01,20\)\/0\.8\)\/2\)\*2\)'/);
  assert.match(g, /rotate=a='\(if\(lt\(\(t-0\),0\),0,[^']*\)\*PI\/180':ow='ceil\(hypot\(iw,ih\)\/2\)\*2'/);
  assert.doesNotMatch(g, /rotate=a=0\.523599/, "rotation keyframes replace the static rotation");
});

async function frameAt(file, t) {
  const { stdout } = await ffmpegRun(["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  return stdout;
}

function rgbAt(frame, x, y, width) {
  const offset = (y * width + x) * 3;
  return [frame[offset], frame[offset + 1], frame[offset + 2]];
}

/** Number of bright pixels along a row or a column. */
function brightRun(frame, width, height, { row, column }) {
  let count = 0;
  const length = row !== undefined ? width : height;
  for (let i = 0; i < length; i += 1) {
    const [r, g, b] = row !== undefined ? rgbAt(frame, i, row, width) : rgbAt(frame, column, i, width);
    if (r + g + b > 3 * 128) count += 1;
  }
  return count;
}

test("exports keyframes, wipes, volume keyframes and RGBA layers", { timeout: 300_000, skip: !ffmpegAvailable }, async () => {
  const work = await mkdtemp(path.join(tmpdir(), "dashcut-composition-keys-"));
  const W = 320;
  const H = 180;
  const white = path.join(work, "white.mp4");
  const blue = path.join(work, "blue.mp4");
  const sine = path.join(work, "sine.m4a");
  const raw = path.join(work, "title.rgba");
  const exportWith = async (name, overrides) => {
    const output = path.join(work, `${name}.mp4`);
    await exportComposition({ width: W, height: H, fps: 30, platform: "youtube", duration: 2, visuals: [], audios: [], subtitles: [], subtitleStyle: {}, ...overrides }, {
      outputPath: output,
      tempPath: work,
      ffmpegPath: ffmpeg,
      platform: process.platform,
      prepareStill: async () => { throw new Error("prepareStill must not be called"); },
    });
    return output;
  };
  const linear = (time, value) => ({ time, value, easing: "linear" });
  try {
    await ffmpegRun(["-f", "lavfi", "-i", `color=c=white:s=${W}x${H}:r=30:d=3`, "-c:v", "mpeg4", "-q:v", "2", "-pix_fmt", "yuv420p", white]);
    await ffmpegRun(["-f", "lavfi", "-i", `color=c=blue:s=${W}x${H}:r=30:d=3`, "-c:v", "mpeg4", "-q:v", "2", "-pix_fmt", "yuv420p", blue]);
    await ffmpegRun(["-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "aac", sine]);
    const rgba = Buffer.alloc(64 * 32 * 4);
    for (let y = 0; y < 32; y += 1) {
      for (let x = 0; x < 64; x += 1) rgba.set([255, 0, 0, x < 32 ? 255 : 0], (y * 64 + x) * 4);
    }
    await writeFile(raw, rgba);
    const layer = (overrides) => visual({ path: white, out: 2, ...overrides });

    // (a) Opacity 0→1 over 1 s: mid grey at 0.5 s, white after the last key.
    const opacity = await exportWith("opacity", { visuals: [layer({ keyframes: { opacity: [linear(0, 0), linear(1, 1)] } })] });
    const grey = rgbAt(await frameAt(opacity, 0.5), 160, 90, W);
    assert.ok(grey.every((value) => value > 100 && value < 156), `mid grey at 0.5 s, got ${grey}`);
    assert.ok(rgbAt(await frameAt(opacity, 0), 160, 90, W).every((value) => value < 30), "transparent at 0 s");
    assert.ok(rgbAt(await frameAt(opacity, 1.5), 160, 90, W).every((value) => value > 225), "opaque after the last key");

    // (b) x keyframes move a small layer from left to right.
    const moving = await exportWith("move", { visuals: [layer({ transform: { x: 0, y: 0, scale: 0.2, rotation: 0, opacity: 1 }, keyframes: { x: [linear(0, -0.35), linear(1, 0.35)] } })] });
    const atStart = await frameAt(moving, 0);
    const atEnd = await frameAt(moving, 1.5);
    assert.ok(rgbAt(atStart, 48, 90, W)[0] > 200 && rgbAt(atStart, 272, 90, W)[0] < 40, "layer on the left at 0 s");
    assert.ok(rgbAt(atEnd, 272, 90, W)[0] > 200 && rgbAt(atEnd, 48, 90, W)[0] < 40, "layer on the right after the last key");
    assert.ok(rgbAt(await frameAt(moving, 0.5), 160, 90, W)[0] > 200, "layer centred half way");

    // (c) Scale keyframes change the size; rotation keyframes turn the layer.
    const scaled = await exportWith("scale", { visuals: [layer({ keyframes: { scale: [linear(0, 0.2), linear(1, 0.6)] } })] });
    for (const [t, expected] of [[0, 64], [0.5, 128], [1.5, 192]]) {
      const run = brightRun(await frameAt(scaled, t), W, H, { row: 90 });
      assert.ok(Math.abs(run - expected) <= 6, `scaled width at ${t}s: expected ${expected}, got ${run}`);
    }
    const rotated = await exportWith("rotate", { visuals: [layer({ transform: { x: 0, y: 0, scale: 0.5, rotation: 0, opacity: 1 }, keyframes: { rotation: [linear(0, 0), linear(1, 90)] } })] });
    const flat = await frameAt(rotated, 0);
    const diagonal = await frameAt(rotated, 0.5);
    const upright = await frameAt(rotated, 1.5);
    assert.ok(Math.abs(brightRun(flat, W, H, { row: 90 }) - 160) <= 6 && Math.abs(brightRun(flat, W, H, { column: 160 }) - 90) <= 6, "unrotated 160×90 at 0 s");
    assert.ok(Math.abs(brightRun(diagonal, W, H, { row: 90 }) - 127) <= 8, `45° row ${brightRun(diagonal, W, H, { row: 90 })}`);
    assert.ok(Math.abs(brightRun(upright, W, H, { row: 90 }) - 90) <= 6 && Math.abs(brightRun(upright, W, H, { column: 160 }) - 160) <= 6, "rotated 90° after the last key");

    // (d) Volume keyframes 0→1 over 1 s: quiet at the start, loud at the end.
    const ramp = await exportWith("volume", { audios: [{ path: sine, start: 0, in: 0, out: 2, speed: 1, audio: { ...quietAudio, volumeKeyframes: [linear(0, 0), linear(1, 1)] } }] });
    const meanVolume = async (from, length) => {
      const { stderr } = await execFileAsync(ffmpeg, ["-hide_banner", "-ss", String(from), "-t", String(length), "-i", ramp, "-map", "0:a", "-af", "volumedetect", "-f", "null", "-"]);
      return Number(stderr.match(/mean_volume: (-?[\d.]+|-inf) dB/)?.[1].replace("-inf", "-200"));
    };
    const early = await meanVolume(0, 0.15);
    const late = await meanVolume(1.4, 0.5);
    assert.ok(late > -28, `loud after the ramp, got ${late} dB`);
    assert.ok(late - early > 15, `ramp from ${early} dB to ${late} dB`);

    // (e) wipe-right in over 1 s: left half revealed at 0.5 s, right half still background.
    // wipe-left out over the last second: only the right p fraction stays visible.
    const wipe = await exportWith("wipe", { visuals: [layer({ animationIn: { type: "wipe-right", duration: 1 }, animationOut: { type: "wipe-left", duration: 1 } })] });
    const half = await frameAt(wipe, 0.5);
    assert.ok(rgbAt(half, 60, 90, W)[0] > 200 && rgbAt(half, 260, 90, W)[0] < 40, "left half revealed at 0.5 s");
    const full = await frameAt(wipe, 1);
    assert.ok(rgbAt(full, 60, 90, W)[0] > 200 && rgbAt(full, 260, 90, W)[0] > 200, "fully revealed between the wipes");
    const leaving = await frameAt(wipe, 1.5);
    assert.ok(rgbAt(leaving, 60, 90, W)[0] < 40 && rgbAt(leaving, 260, 90, W)[0] > 200, "wipe-left out keeps the right half at 1.5 s");

    // (f) RGBA title: alpha is preserved, so its transparent half shows the blue layer below.
    const title = await exportWith("rgba", { visuals: [visual({ path: blue, out: 2 }), visual({ path: raw, kind: "rgba", rgba: { width: 64, height: 32 }, out: 2 })] });
    for (const t of [0.2, 1.5]) {
      const frame = await frameAt(title, t);
      const left = rgbAt(frame, 80, 90, W);
      const right = rgbAt(frame, 240, 90, W);
      assert.ok(left[0] > 200 && left[2] < 60, `opaque half is red at ${t}s, got ${left}`);
      assert.ok(right[2] > 200 && right[0] < 60, `transparent half shows blue at ${t}s, got ${right}`);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("normalises output settings and parses FFmpeg meters", () => {
  assert.deepEqual(normalizeOutput(undefined), { format: "mp4", codec: "h264", loudnessTarget: null, gif: { fps: 12, width: 480, maxDuration: 15 } });
  assert.equal(normalizeOutput({ format: "gif", codec: "h264", loudnessTarget: -14 }).loudnessTarget, null, "GIFs have no audio to normalise");
  assert.equal(normalizeOutput({ format: "wav", codec: "hevc", loudnessTarget: -16 }).loudnessTarget, -16);
  assert.equal(normalizeOutput({ format: "gif", codec: "h264", loudnessTarget: null, gif: { fps: 15, width: 321, maxDuration: 4 } }).gif.width, 322);

  const loudnorm = `[Parsed_loudnorm_0 @ 0x1] \n{\n\t"input_i" : "-33.20",\n\t"input_tp" : "-29.98",\n\t"input_lra" : "0.00",\n\t"input_thresh" : "-43.20",\n\t"target_offset" : "-0.05"\n}\n`;
  assert.deepEqual(parseLoudnormJson(loudnorm), { I: -33.2, TP: -29.98, LRA: 0, thresh: -43.2, offset: -0.05 });
  assert.equal(parseLoudnormJson(loudnorm.replace('"-33.20"', '"-inf"')), null, "silence cannot be normalised");

  const summary = "Summary:\n\n  Integrated loudness:\n    I:         -70.0 LUFS\n    Threshold:   0.0 LUFS\n\n  Loudness range:\n    LRA:         0.0 LU\n\n  True peak:\n    Peak:       -inf dBFS\n";
  assert.deepEqual(parseEbur128Summary(summary), { integratedLufs: null, loudnessRange: 0, truePeak: null });
  assert.deepEqual(parseEbur128Summary(summary.replace("-70.0", "-14.2").replace("-inf", "-1.6")), { integratedLufs: -14.2, loudnessRange: 0, truePeak: -1.6 });
  assert.deepEqual(parseEbur128Summary(""), { integratedLufs: null, loudnessRange: null, truePeak: null });

  assert.deepEqual(parseSilences("silence_start: 1.5\nsilence_end: 4.5 | silence_duration: 3\nsilence_start: 8\n", 10), [{ start: 1.5, end: 4.5 }, { start: 8, end: 10 }]);
});

test("graph renders only the audio mix for audio formats", () => {
  const graph = buildCompositionGraph({
    width: 640, height: 360, fps: 30, duration: 3,
    visuals: [visual({ path: "/media/still.jpg", kind: "image", out: 3 }), visual({ path: "/media/a.mp4", out: 3, hasAudio: true })],
    audios: [{ path: "/media/music.m4a", start: 0, in: 0, out: 3, speed: 1, audio: quietAudio }],
  }, { audioOnly: true, audioFilters: ["loudnorm=I=-14", "aresample=48000"] });
  assert.equal(graph.videoLabel, null);
  assert.doesNotMatch(graph.inputs.join(" "), /still\.jpg/, "stills are not decoded for audio-only exports");
  assert.doesNotMatch(graph.filterGraph, /color=c=black|overlay|\[vout\]/);
  assert.match(graph.filterGraph, /\[0:a:0\].*\[va1\]/);
  assert.match(graph.filterGraph, /\[1:a:0\].*\[aa0\]/);
  assert.match(graph.filterGraph, /channel_layouts=stereo,loudnorm=I=-14,aresample=48000\[aout\]$/);
});

/** Small red clip with a 440 Hz tone and a tone-only music file. */
async function makeFormatMedia(work) {
  const red = path.join(work, "red.mp4");
  const music = path.join(work, "music.m4a");
  await ffmpegRun(["-f", "lavfi", "-i", "color=c=red:s=320x180:r=30:d=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-shortest", "-c:v", "mpeg4", "-q:v", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", red]);
  await ffmpegRun(["-f", "lavfi", "-i", "sine=frequency=880:duration=3", "-c:a", "aac", music]);
  return {
    red,
    request: (output, overrides = {}) => ({
      output,
      width: 320,
      height: 180,
      fps: 30,
      platform: "youtube",
      duration: 2,
      visuals: [visual({ path: red, out: 3, hasAudio: true })],
      audios: [{ path: music, start: 0.5, in: 0, out: 1.5, speed: 1, audio: quietAudio }],
      subtitles: [{ start: 0, end: 1, zh: "格式", en: "Format" }],
      subtitleStyle: {},
      ...overrides,
    }),
  };
}

async function exists(file) {
  return access(file).then(() => true, () => false);
}

test("exports HEVC MP4 with the hvc1 tag", { timeout: 120_000, skip: !ffmpegAvailable || process.platform !== "darwin" }, async () => {
  const work = await mkdtemp(path.join(tmpdir(), "dashcut-composition-hevc-"));
  try {
    const media = await makeFormatMedia(work);
    const output = path.join(work, "hevc.mp4");
    const result = await exportComposition(media.request({ format: "mp4", codec: "hevc", loudnessTarget: null }), { outputPath: output, tempPath: work, ffmpegPath: ffmpeg, platform: process.platform });
    assert.equal(result.subtitleFiles.length, 2);
    assert.ok(await exists(path.join(work, "hevc.zh.srt")));
    const { stderr, seconds } = await probe(output);
    assert.match(stderr, /Video: hevc[^\n]*\(hvc1 \//);
    assert.match(stderr, /Audio: aac.*48000 Hz, stereo/);
    assert.ok(Math.abs(seconds - 2) <= 0.15, `expected ~2s, got ${seconds}`);
    const { stderr: errors } = await execFileAsync(ffmpeg, ["-hide_banner", "-v", "error", "-i", output, "-f", "null", "-"]);
    assert.equal(String(errors).trim(), "");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("exports the audio mix alone as M4A and WAV", { timeout: 120_000, skip: !ffmpegAvailable }, async () => {
  const work = await mkdtemp(path.join(tmpdir(), "dashcut-composition-audio-"));
  try {
    const media = await makeFormatMedia(work);
    for (const [format, codec] of [["m4a", /Audio: aac[^\n]*48000 Hz, stereo/], ["wav", /Audio: pcm_s16le[^\n]*48000 Hz, (2 channels|stereo)/]]) {
      const output = path.join(work, `mix.${format}`);
      const progress = [];
      const result = await exportComposition(media.request({ format, codec: "h264", loudnessTarget: null }), {
        outputPath: output, tempPath: work, ffmpegPath: ffmpeg, platform: process.platform,
        onProgress: (item) => progress.push(item.progress),
        prepareStill: async () => { throw new Error("audio exports must not prepare stills"); },
      });
      assert.deepEqual(result.subtitleFiles, []);
      assert.equal(progress.at(-1), 100);
      assert.equal(await exists(path.join(work, "mix.zh.srt")), false, "no caption sidecars for audio");
      const { stderr, seconds } = await probe(output);
      assert.match(stderr, codec);
      assert.doesNotMatch(stderr, /Video:/);
      assert.ok(Math.abs(seconds - 2) <= 0.1, `${format}: expected ~2s, got ${seconds}`);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("exports a palette GIF at the requested width, capped in length", { timeout: 120_000, skip: !ffmpegAvailable }, async () => {
  const work = await mkdtemp(path.join(tmpdir(), "dashcut-composition-gif-"));
  try {
    const media = await makeFormatMedia(work);
    const output = path.join(work, "clip.gif");
    const result = await exportComposition(media.request({ format: "gif", codec: "h264", loudnessTarget: null, gif: { fps: 10, width: 160, maxDuration: 1.5 } }, { duration: 3 }), { outputPath: output, tempPath: work, ffmpegPath: ffmpeg, platform: process.platform });
    assert.equal(result.duration, 1.5);
    assert.deepEqual(result.subtitleFiles, []);
    const { stderr, seconds } = await probe(output);
    assert.match(stderr, /Video: gif[^\n]*160x90/);
    assert.doesNotMatch(stderr, /Audio:/);
    assert.ok(seconds <= 1.5 + 0.05 && seconds >= 1.3, `expected ≤1.5s, got ${seconds}`);
    const { stderr: errors } = await execFileAsync(ffmpeg, ["-hide_banner", "-v", "error", "-i", output, "-f", "null", "-"]);
    assert.equal(String(errors).trim(), "");
    const frame = await frameAt(output, 1.2);
    assert.ok(rgbAt(frame, 80, 20, 160)[0] > 180, "red picture survives palette quantisation");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

async function integratedLoudness(file) {
  const { stderr } = await execFileAsync(ffmpeg, ["-hide_banner", "-i", file, "-map", "0:a", "-af", "ebur128=framelog=quiet", "-f", "null", "-"]);
  return parseEbur128Summary(stderr).integratedLufs;
}

test("normalises a quiet mix to the loudness target in two passes", { timeout: 180_000, skip: !ffmpegAvailable }, async () => {
  const work = await mkdtemp(path.join(tmpdir(), "dashcut-composition-loudness-"));
  try {
    const quiet = path.join(work, "quiet.wav");
    // sine's default amplitude is 1/8 (-18 dBFS); -12 dB more gives a -30 dBFS tone.
    await ffmpegRun(["-f", "lavfi", "-i", "sine=frequency=1000:duration=4:sample_rate=48000,volume=-12dB", "-c:a", "pcm_s16le", quiet]);
    const before = await integratedLoudness(quiet);
    assert.ok(before < -30, `source is quiet, got ${before}`);
    const request = (format) => ({
      output: { format, codec: "h264", loudnessTarget: -14 },
      width: 320, height: 180, fps: 30, platform: "youtube", duration: 3,
      visuals: [], audios: [{ path: quiet, start: 0, in: 0, out: 3, speed: 1, audio: quietAudio }],
      subtitles: [], subtitleStyle: {},
    });
    for (const format of ["mp4", "wav"]) {
      const output = path.join(work, `loud.${format}`);
      const progress = [];
      await exportComposition(request(format), { outputPath: output, tempPath: work, ffmpegPath: ffmpeg, platform: process.platform, onProgress: (item) => progress.push(item.progress) });
      const after = await integratedLoudness(output);
      assert.ok(Math.abs(after + 14) <= 1.5, `${format}: expected -14 ±1.5 LUFS, got ${after}`);
      assert.ok(progress.includes(25), "render pass starts at 25 %");
      assert.deepEqual(progress, [...progress].sort((a, b) => a - b), "progress never goes backwards");
      assert.equal(progress.at(-1), 100);
      const { stderr } = await probe(output);
      assert.match(stderr, /Audio: [^\n]*48000 Hz/, "loudnorm's upsampling is undone");
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("analyses loudness, silences and black frames without writing a file", { timeout: 180_000, skip: !ffmpegAvailable }, async () => {
  const work = await mkdtemp(path.join(tmpdir(), "dashcut-composition-analysis-"));
  try {
    const red = path.join(work, "red.mp4");
    const yellow = path.join(work, "yellow.mp4");
    const tone = path.join(work, "tone.m4a");
    await ffmpegRun(["-f", "lavfi", "-i", "color=c=red:s=320x180:r=30:d=4", "-c:v", "mpeg4", "-q:v", "2", "-pix_fmt", "yuv420p", red]);
    await ffmpegRun(["-f", "lavfi", "-i", "color=c=yellow:s=320x180:r=30:d=4", "-c:v", "mpeg4", "-q:v", "2", "-pix_fmt", "yuv420p", yellow]);
    await ffmpegRun(["-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "aac", tone]);
    const toneClip = { path: tone, start: 0, in: 0, out: 1.5, speed: 1, audio: quietAudio };
    const request = {
      width: 640, height: 360, fps: 30, platform: "youtube", duration: 6,
      // Picture: red 0-1.5 s, black 1.5-2.5 s, yellow 2.5-6 s. Audio: tone 0-1.5 s and 4.5-6 s.
      visuals: [visual({ path: red, out: 1.5 }), visual({ path: yellow, start: 2.5, out: 3.5 })],
      audios: [toneClip, { ...toneClip, start: 4.5 }],
      subtitles: [{ start: 0, end: 6, zh: "字幕", en: "Caption" }], subtitleStyle: {},
    };
    const progress = [];
    const before = new Set(await readdir(work));
    const analysis = await analyzeComposition(request, { tempPath: work, ffmpegPath: ffmpeg, onProgress: (item) => progress.push(item.progress) });
    assert.deepEqual(new Set(await readdir(work)), before, "no files left behind");
    assert.equal(analysis.duration, 6);
    assert.equal(progress.at(-1), 100);
    assert.equal(analysis.blackFrames.length, 1, JSON.stringify(analysis.blackFrames));
    assert.ok(Math.abs(analysis.blackFrames[0].start - 1.5) <= 0.2 && Math.abs(analysis.blackFrames[0].end - 2.5) <= 0.2, JSON.stringify(analysis.blackFrames));
    assert.equal(analysis.silences.length, 1, JSON.stringify(analysis.silences));
    assert.ok(Math.abs(analysis.silences[0].start - 1.5) <= 0.2 && Math.abs(analysis.silences[0].end - 4.5) <= 0.2, JSON.stringify(analysis.silences));
    assert.equal(typeof analysis.integratedLufs, "number");
    assert.ok(analysis.integratedLufs < -10 && analysis.integratedLufs > -40, `integrated ${analysis.integratedLufs}`);
    assert.equal(typeof analysis.truePeak, "number");
    assert.equal(typeof analysis.loudnessRange, "number");

    const silent = await analyzeComposition({ ...request, audios: [] }, { tempPath: work, ffmpegPath: ffmpeg });
    assert.equal(silent.integratedLufs, null);
    assert.equal(silent.truePeak, null);
    assert.deepEqual(silent.silences, [{ start: 0, end: 6 }]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
