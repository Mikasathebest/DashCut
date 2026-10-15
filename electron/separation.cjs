/* eslint-disable @typescript-eslint/no-require-imports */
// Local voice / background separation (Demucs htdemucs, 2 stems).
//
// The runtime (local-runtime/dashcut-separate, built by scripts/build-separation-runtime.mjs)
// is optional: when it is absent every entry point reports "声音分离组件未安装" and the rest
// of the app keeps working. Model weights are downloaded into the app's models directory
// only after an explicit install action, mirroring the Whisper model flow.
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { access, mkdir, readFile, rm, stat, writeFile } = require("node:fs/promises");
const path = require("node:path");

const SEPARATION_MODEL = Object.freeze({
  id: "htdemucs",
  label: "HTDemucs",
  file: "955717e8-8726e21a.th",
  sizeBytes: 84_141_911,
  license: "MIT",
});
// Bump when the engine's output changes so stale cached stems are not reused.
const CACHE_VERSION = 1;
const EXECUTABLE = process.platform === "win32" ? "dashcut-separate.exe" : "dashcut-separate";

const ERRORS = Object.freeze({
  runtimeMissing: "声音分离组件未安装",
  modelMissing: "声音分离模型尚未下载",
  inputMissing: "找不到需要分离的素材文件",
  invalidResult: "声音分离组件返回了无效结果",
});

async function pathExists(target) {
  try { await access(target); return true; }
  catch { return false; }
}

function appRoot(options) {
  return options.appRoot ?? path.join(__dirname, "..");
}

function modelRoot(options) {
  if (options.separationModelRoot) return options.separationModelRoot;
  if (!options.modelsPath) throw new Error("缺少模型目录");
  return path.join(options.modelsPath, "separation");
}

function modelDir(options) {
  return path.join(modelRoot(options), SEPARATION_MODEL.id);
}

async function isSeparationModelReady(options) {
  try {
    const weights = await stat(path.join(modelDir(options), SEPARATION_MODEL.file));
    return weights.isFile() && weights.size === SEPARATION_MODEL.sizeBytes
      && await pathExists(path.join(modelDir(options), `${SEPARATION_MODEL.id}.yaml`));
  } catch {
    return false;
  }
}

// Same discovery order as model-manager: the bundled runtime when packaged, the locally built
// runtime in development, and finally the build venv running local-engine/separate.py.
async function resolveSeparationRuntime(options = {}) {
  if (options.bundledSeparatorPath && await pathExists(options.bundledSeparatorPath)) {
    return { kind: "bundled", executable: options.bundledSeparatorPath, prefixArgs: [], ready: true };
  }
  if (!options.isPackaged) {
    const root = appRoot(options);
    const built = path.join(root, "local-runtime", "dashcut-separate", EXECUTABLE);
    if (await pathExists(built)) return { kind: "local-runtime", executable: built, prefixArgs: [], ready: true };
    const venvPython = process.platform === "win32"
      ? path.join(root, ".separation-venv", "Scripts", "python.exe")
      : path.join(root, ".separation-venv", "bin", "python");
    const script = options.devSeparatorPath ?? path.join(root, "local-engine", "separate.py");
    if (await pathExists(venvPython) && await pathExists(script)) {
      return { kind: "development", executable: venvPython, prefixArgs: [script], ready: true };
    }
  }
  return { kind: "missing", executable: "", prefixArgs: [], ready: false };
}

function engineError(stderr, fallback) {
  const lines = String(stderr || "").split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.error === "string" && parsed.error) return parsed.error;
    } catch { /* not the error line */ }
  }
  const plain = lines.filter((line) => !line.startsWith("PROGRESS ")).reverse().join("\n");
  return plain.slice(-2000) || fallback;
}

// Default process runner: resolves the engine's stdout JSON, streams PROGRESS lines.
function spawnRunner(command, args, execution = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      // Ops without an MPS kernel fall back to CPU instead of aborting.
      env: { ...process.env, PYTORCH_ENABLE_MPS_FALLBACK: "1", PYTHONIOENCODING: "utf-8" },
      signal: execution.signal,
    });
    let stdout = "";
    let stderr = "";
    let pending = "";
    const timer = setTimeout(() => child.kill(), execution.timeout ?? 6 * 60 * 60 * 1000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop();
      for (const line of lines) {
        const match = /^PROGRESS ([\d.]+)$/.exec(line.trim());
        if (match) execution.onProgress?.(Number(match[1]));
        else if (stderr.length < 200_000) stderr += `${line}\n`;
      }
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      stderr += pending;
      if (code !== 0) {
        reject(new Error(engineError(stderr, signal ? `声音分离已中止（${signal}）` : `声音分离组件退出（${code}）`)));
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error(engineError(stderr, ERRORS.invalidResult))); }
    });
  });
}

async function runSeparationEngine(args, options, execution = {}) {
  const runtime = await resolveSeparationRuntime(options);
  if (!runtime.ready) throw new Error(ERRORS.runtimeMissing);
  const runner = options.runner ?? spawnRunner;
  return runner(runtime.executable, [...runtime.prefixArgs, ...args], execution);
}

async function getSeparationStatus(options = {}) {
  const runtime = await resolveSeparationRuntime(options);
  const modelInstalled = await isSeparationModelReady(options);
  let info = null;
  let error;
  if (runtime.ready && options.probe) {
    try { info = await runSeparationEngine(["--runtime-info"], options, { timeout: 60_000 }); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  }
  return {
    runtime: { kind: runtime.kind, ready: runtime.ready && !error, info, ...(error ? { error } : {}) },
    model: { ...SEPARATION_MODEL, installed: modelInstalled, path: modelDir(options) },
    ready: runtime.ready && !error && modelInstalled,
    message: !runtime.ready ? ERRORS.runtimeMissing : !modelInstalled ? ERRORS.modelMissing : undefined,
  };
}

async function installSeparationModel(options = {}, onProgress) {
  if (await isSeparationModelReady(options)) return { model: SEPARATION_MODEL.id, path: modelDir(options), alreadyInstalled: true };
  const runtime = await resolveSeparationRuntime(options);
  if (!runtime.ready) throw new Error(ERRORS.runtimeMissing);
  await mkdir(modelRoot(options), { recursive: true });
  const result = await runSeparationEngine(["--download-model", "--model-root", modelRoot(options)], options, {
    timeout: 60 * 60 * 1000,
    onProgress: (progress) => onProgress?.({ progress, stage: "下载声音分离模型" }),
    signal: options.signal,
  });
  if (!await isSeparationModelReady(options)) throw new Error("声音分离模型下载未完成或文件校验失败");
  return result;
}

async function removeSeparationModel(options = {}) {
  await rm(modelDir(options), { recursive: true, force: true });
  return { model: SEPARATION_MODEL.id, removed: true };
}

function separationCacheKey(input, file) {
  return createHash("sha256")
    .update(JSON.stringify([CACHE_VERSION, SEPARATION_MODEL.id, path.resolve(input), Number(file.size), Number(file.mtimeMs)]))
    .digest("hex")
    .slice(0, 32);
}

async function readCached(dir) {
  try {
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
    const vocals = path.join(dir, "vocals.wav");
    const background = path.join(dir, "background.wav");
    if (!await pathExists(vocals) || !await pathExists(background)) return null;
    return { vocals, background, duration: manifest.duration, device: manifest.device, cached: true };
  } catch {
    return null;
  }
}

function defaultDevice(requested) {
  if (requested === "cpu" || requested === "mps") return requested;
  // MPS output matched CPU bit-for-bit within float tolerance and runs ~1.6x faster on M-series.
  return process.platform === "darwin" && process.arch === "arm64" ? "mps" : "cpu";
}

const inFlight = new Map();

async function separateAudio(request, options = {}, onProgress) {
  const input = request?.input;
  const cacheDir = request?.cacheDir;
  if (typeof input !== "string" || !path.isAbsolute(input)) throw new Error(ERRORS.inputMissing);
  if (typeof cacheDir !== "string" || !path.isAbsolute(cacheDir)) throw new Error("声音分离缓存目录无效");
  let file;
  try { file = await stat(input); }
  catch { throw new Error(ERRORS.inputMissing); }
  if (!file.isFile()) throw new Error(ERRORS.inputMissing);

  const key = separationCacheKey(input, file);
  const dir = path.join(cacheDir, key);
  const cached = await readCached(dir);
  if (cached) {
    onProgress?.({ progress: 1, stage: "声音分离" });
    return cached;
  }
  if (inFlight.has(dir)) return inFlight.get(dir);

  const job = (async () => {
    const runtime = await resolveSeparationRuntime(options);
    if (!runtime.ready) throw new Error(ERRORS.runtimeMissing);
    if (!await isSeparationModelReady(options)) throw new Error(ERRORS.modelMissing);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const run = (device) => runSeparationEngine([
      "--input", input,
      "--output-dir", dir,
      "--model-root", modelRoot(options),
      "--device", device,
      ...(request.ffmpegPath ? ["--ffmpeg", request.ffmpegPath] : []),
    ], options, {
      onProgress: (progress) => onProgress?.({ progress, stage: "声音分离" }),
      signal: options.signal,
    });
    const device = defaultDevice(request.device ?? options.device);
    let result;
    try {
      result = await run(device);
    } catch (error) {
      // Apple GPU problems should never block the feature: retry once on the CPU.
      if (device !== "mps" || options.signal?.aborted) throw error;
      result = await run("cpu");
    }
    const vocals = path.join(dir, "vocals.wav");
    const background = path.join(dir, "background.wav");
    if (!await pathExists(vocals) || !await pathExists(background)) throw new Error(ERRORS.invalidResult);
    const manifest = {
      version: CACHE_VERSION,
      model: SEPARATION_MODEL.id,
      input: path.resolve(input),
      size: file.size,
      mtimeMs: file.mtimeMs,
      duration: Number(result?.duration) || 0,
      device: result?.device ?? device,
      createdAt: new Date().toISOString(),
    };
    // Written last: its presence marks the cache entry complete.
    await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    return { vocals, background, duration: manifest.duration, device: manifest.device, cached: false };
  })();
  inFlight.set(dir, job);
  try {
    return await job;
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    inFlight.delete(dir);
  }
}

module.exports = {
  SEPARATION_MODEL,
  getSeparationStatus,
  installSeparationModel,
  isSeparationModelReady,
  removeSeparationModel,
  resolveSeparationRuntime,
  separateAudio,
  separationCacheKey,
};
