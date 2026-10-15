import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test, { after, before } from "node:test";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const {
  SEPARATION_MODEL,
  getSeparationStatus,
  installSeparationModel,
  resolveSeparationRuntime,
  separateAudio,
} = require("../electron/separation.cjs");
const { resolveFfmpegExecutable } = require("../electron/video-export.cjs");

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let work = "";

before(async () => {
  work = await mkdtemp(path.join(tmpdir(), "dashcut-separation-test-"));
});

after(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

async function fakeSetup(name, { model = true } = {}) {
  const dir = path.join(work, name);
  const appRoot = path.join(dir, "app");
  const runner = path.join(dir, "dashcut-separate");
  const modelsPath = path.join(dir, "models");
  await mkdir(appRoot, { recursive: true });
  await writeFile(runner, "");
  if (model) await installFakeModel(modelsPath);
  const input = path.join(dir, "clip.mov");
  await writeFile(input, "fake media");
  return { dir, appRoot, runner, modelsPath, input, cacheDir: path.join(dir, "cache") };
}

async function installFakeModel(modelsPath) {
  const target = path.join(modelsPath, "separation", SEPARATION_MODEL.id);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, SEPARATION_MODEL.file), Buffer.alloc(SEPARATION_MODEL.sizeBytes));
  await writeFile(path.join(target, `${SEPARATION_MODEL.id}.yaml`), "models: ['955717e8']\n");
}

// Fake engine: records calls and writes the two stems like separate.py does.
function fakeRunner(calls, { fail } = {}) {
  return async (command, args, execution) => {
    calls.push({ command, args });
    const option = (name) => args[args.indexOf(name) + 1];
    if (fail) throw new Error(fail(option));
    if (args.includes("--download-model")) {
      await installFakeModel(path.dirname(option("--model-root")));
      return { model: "htdemucs" };
    }
    execution.onProgress?.(0.5);
    const out = option("--output-dir");
    await writeFile(path.join(out, "vocals.wav"), "v");
    await writeFile(path.join(out, "background.wav"), "b");
    return { vocals: path.join(out, "vocals.wav"), background: path.join(out, "background.wav"), duration: 3, device: option("--device") };
  };
}

test("status reports a missing runtime without failing", async () => {
  const setup = await fakeSetup("missing", { model: false });
  const options = { appRoot: setup.appRoot, modelsPath: setup.modelsPath, isPackaged: false };
  const status = await getSeparationStatus(options);
  assert.equal(status.runtime.ready, false);
  assert.equal(status.runtime.kind, "missing");
  assert.equal(status.model.installed, false);
  assert.equal(status.ready, false);
  assert.equal(status.message, "声音分离组件未安装");
  await assert.rejects(installSeparationModel(options), /声音分离组件未安装/);
  await assert.rejects(separateAudio({ input: setup.input, cacheDir: setup.cacheDir }, options), /声音分离组件未安装/);
});

test("packaged builds never fall back to development runtimes", async () => {
  const runtime = await resolveSeparationRuntime({ isPackaged: true, appRoot: rootDir, bundledSeparatorPath: path.join(work, "nope") });
  assert.equal(runtime.ready, false);
});

test("status and separation require the downloaded model", async () => {
  const setup = await fakeSetup("no-model", { model: false });
  const calls = [];
  const options = { appRoot: setup.appRoot, bundledSeparatorPath: setup.runner, modelsPath: setup.modelsPath, runner: fakeRunner(calls) };
  const status = await getSeparationStatus(options);
  assert.equal(status.runtime.ready, true);
  assert.equal(status.runtime.kind, "bundled");
  assert.equal(status.model.installed, false);
  assert.equal(status.message, "声音分离模型尚未下载");
  await assert.rejects(separateAudio({ input: setup.input, cacheDir: setup.cacheDir }, options), /声音分离模型尚未下载/);
  assert.equal(calls.length, 0);

  const progress = [];
  await installSeparationModel(options, (update) => progress.push(update));
  assert.deepEqual(calls[0].args.slice(0, 3), ["--download-model", "--model-root", path.join(setup.modelsPath, "separation")]);
  assert.equal((await getSeparationStatus(options)).ready, true);
  const again = await installSeparationModel(options);
  assert.equal(again.alreadyInstalled, true);
  assert.equal(calls.length, 1);
});

test("separation results are cached by input path, size and mtime", async () => {
  const setup = await fakeSetup("cache");
  const calls = [];
  const options = { appRoot: setup.appRoot, bundledSeparatorPath: setup.runner, modelsPath: setup.modelsPath, runner: fakeRunner(calls), device: "cpu" };
  const request = { input: setup.input, cacheDir: setup.cacheDir, ffmpegPath: "/opt/ffmpeg" };
  const progress = [];
  const first = await separateAudio(request, options, (update) => progress.push(update.progress));
  assert.equal(first.cached, false);
  assert.equal(first.device, "cpu");
  assert.equal(await readFile(first.vocals, "utf8"), "v");
  assert.equal(await readFile(first.background, "utf8"), "b");
  assert.ok(progress.includes(0.5));
  const args = calls[0].args;
  assert.equal(args[args.indexOf("--ffmpeg") + 1], "/opt/ffmpeg");
  assert.equal(args[args.indexOf("--input") + 1], setup.input);

  const second = await separateAudio(request, options);
  assert.equal(second.cached, true);
  assert.equal(second.vocals, first.vocals);
  assert.equal(calls.length, 1, "cached call must not launch the engine");

  // Same path, new contents (mtime/size change) -> new cache entry.
  await writeFile(setup.input, "edited fake media");
  await utimes(setup.input, new Date(), new Date(Date.now() + 5_000));
  const third = await separateAudio(request, options);
  assert.equal(third.cached, false);
  assert.notEqual(path.dirname(third.vocals), path.dirname(first.vocals));
  assert.equal(calls.length, 2);
});

test("concurrent requests for the same input share one engine run", async () => {
  const setup = await fakeSetup("concurrent");
  const calls = [];
  const options = { appRoot: setup.appRoot, bundledSeparatorPath: setup.runner, modelsPath: setup.modelsPath, runner: fakeRunner(calls), device: "cpu" };
  const request = { input: setup.input, cacheDir: setup.cacheDir };
  const [a, b] = await Promise.all([separateAudio(request, options), separateAudio(request, options)]);
  assert.equal(a.vocals, b.vocals);
  assert.equal(calls.length, 1);
});

test("failed runs leave no cache entry and surface the engine error", async () => {
  const setup = await fakeSetup("failure");
  const calls = [];
  const options = {
    appRoot: setup.appRoot, bundledSeparatorPath: setup.runner, modelsPath: setup.modelsPath, device: "cpu",
    runner: fakeRunner(calls, { fail: () => "素材没有音轨，无法分离人声" }),
  };
  await assert.rejects(separateAudio({ input: setup.input, cacheDir: setup.cacheDir }, options), /素材没有音轨/);
  const okOptions = { ...options, runner: fakeRunner(calls) };
  const result = await separateAudio({ input: setup.input, cacheDir: setup.cacheDir }, okOptions);
  assert.equal(result.cached, false);
});

test("an MPS failure is retried once on the CPU", async () => {
  const setup = await fakeSetup("mps-retry");
  const calls = [];
  const succeed = fakeRunner(calls);
  const options = {
    appRoot: setup.appRoot, bundledSeparatorPath: setup.runner, modelsPath: setup.modelsPath, device: "mps",
    runner: async (command, args, execution) => {
      if (args[args.indexOf("--device") + 1] === "mps") { calls.push({ args }); throw new Error("MPS backend out of memory"); }
      return succeed(command, args, execution);
    },
  };
  const result = await separateAudio({ input: setup.input, cacheDir: setup.cacheDir }, options);
  assert.equal(result.device, "cpu");
  assert.equal(calls.length, 2);
});

test("rejects relative or missing inputs", async () => {
  const setup = await fakeSetup("inputs");
  const options = { appRoot: setup.appRoot, bundledSeparatorPath: setup.runner, modelsPath: setup.modelsPath, runner: fakeRunner([]) };
  await assert.rejects(separateAudio({ input: "clip.mov", cacheDir: setup.cacheDir }, options), /找不到需要分离的素材文件/);
  await assert.rejects(separateAudio({ input: path.join(setup.dir, "absent.mov"), cacheDir: setup.cacheDir }, options), /找不到需要分离的素材文件/);
});

// ---- End-to-end: real runtime + real model (skipped unless both are present) ----

const e2eModelRoot = process.env.DASHCUT_SEPARATION_MODEL_ROOT ?? "";
const ffmpeg = resolveFfmpegExecutable();
const ffmpegAvailable = spawnSync(ffmpeg, ["-hide_banner", "-version"], { windowsHide: true }).status === 0;
const sayAvailable = process.platform === "darwin" && existsSync("/usr/bin/say");
const e2eOptions = { appRoot: rootDir, isPackaged: false, separationModelRoot: e2eModelRoot };
const e2eRuntime = await resolveSeparationRuntime(e2eOptions);
const e2eModelReady = Boolean(e2eModelRoot) && (await getSeparationStatus(e2eOptions)).model.installed;
const e2eSkip = !e2eRuntime.ready ? "separation runtime not built (npm run runtime:separate:build)"
  : !e2eModelReady ? "set DASHCUT_SEPARATION_MODEL_ROOT to a directory with the htdemucs model"
    : !ffmpegAvailable ? "ffmpeg not available"
      : !sayAvailable ? "needs macOS `say` for the synthetic voice"
        : false;

async function readMonoPcm(file) {
  // Decode any WAV to raw mono float32 via ffmpeg so the test does not parse RIFF itself.
  const { stdout } = await execFileAsync(ffmpeg, ["-hide_banner", "-v", "error", "-i", file, "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  return new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 4));
}

function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  let ab = 0; let aa = 0; let bb = 0;
  for (let i = 0; i < n; i += 1) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return ab / Math.sqrt(aa * bb + 1e-12);
}

test("separates a synthetic voice from a tone bed", { skip: e2eSkip, timeout: 10 * 60_000 }, async () => {
  const dir = path.join(work, "e2e");
  await mkdir(dir, { recursive: true });
  const voiceAiff = path.join(dir, "voice.aiff");
  await execFileAsync("/usr/bin/say", ["-o", voiceAiff, "Hello, this is a test of the voice separation feature. The quick brown fox jumps over the lazy dog."]);
  const voice = path.join(dir, "voice.wav");
  const mix = path.join(dir, "mix.mp4");
  await execFileAsync(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-i", voiceAiff, "-af", "apad=whole_dur=8", "-ar", "48000", "-ac", "2", "-t", "8", voice]);
  // Music-like bed: bass + pulsing chord partials, mixed under the voice, AAC in MP4 like real footage.
  await execFileAsync(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-i", voice,
    "-f", "lavfi", "-i", "aevalsrc='0.15*sin(2*PI*110*t)+0.1*sin(2*PI*220*t)*(0.5+0.5*sin(2*PI*2*t))+0.08*sin(2*PI*330*t)':s=48000:d=8",
    "-filter_complex", "[0][1]amix=inputs=2:normalize=0[a]", "-map", "[a]", "-ac", "2", "-c:a", "aac", "-b:a", "192k", mix]);

  const progress = [];
  const started = Date.now();
  const result = await separateAudio({ input: mix, cacheDir: path.join(dir, "cache"), ffmpegPath: ffmpeg }, e2eOptions, (update) => progress.push(update.progress));
  const seconds = (Date.now() - started) / 1000;
  assert.equal(result.cached, false);
  assert.ok(progress.at(-1) >= 0.99, `final progress ${progress.at(-1)}`);
  near(result.duration, 8, 0.2);

  const [reference, vocals, background] = await Promise.all([voice, result.vocals, result.background].map(readMonoPcm));
  const vocalsCorr = correlation(vocals, reference);
  const backgroundCorr = correlation(background, reference);
  console.log(`# e2e separation: ${seconds.toFixed(1)}s on ${result.device}, corr(vocals, voice)=${vocalsCorr.toFixed(3)}, corr(background, voice)=${backgroundCorr.toFixed(3)}`);
  assert.ok(vocalsCorr > 0.8, `vocals should track the voice (corr ${vocalsCorr})`);
  assert.ok(Math.abs(backgroundCorr) < 0.2, `background should not contain the voice (corr ${backgroundCorr})`);

  const probe = spawnSync(ffmpeg, ["-hide_banner", "-i", result.vocals], { encoding: "utf8" }).stderr;
  assert.match(probe, /pcm_s16le.*, 48000 Hz, stereo, s16/);

  const cached = await separateAudio({ input: mix, cacheDir: path.join(dir, "cache"), ffmpegPath: ffmpeg }, e2eOptions);
  assert.equal(cached.cached, true);
});

function near(actual, expected, tolerance) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ~${expected}, got ${actual}`);
}
