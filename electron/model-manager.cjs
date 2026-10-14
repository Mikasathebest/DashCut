/* eslint-disable @typescript-eslint/no-require-imports */
const { execFile } = require("node:child_process");
const { access, mkdir, readdir, rm, stat } = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const { findPython } = require("./hardware.cjs");

const execFileAsync = promisify(execFile);
const MODEL_CATALOG = {
  small: { label: "Small", approximateGb: 0.5, quality: "快速", description: "适合 CPU 和短视频" },
  medium: { label: "Medium", approximateGb: 1.5, quality: "较高", description: "适合高性能 CPU 或入门 GPU" },
  turbo: { label: "Turbo", approximateGb: 1.6, quality: "较高", description: "接近 Large 的准确度，CPU / Apple Silicon 上速度快数倍" },
  "large-v3": { label: "Large v3", approximateGb: 3.1, quality: "最高", description: "最高准确度，适合 8 GB+ 显存的 CUDA GPU" },
};

function validModel(model) {
  if (!Object.hasOwn(MODEL_CATALOG, model)) throw new Error("不支持的本地模型");
  return model;
}

async function pathExists(target) {
  try { await access(target); return true; }
  catch { return false; }
}

function modelPath(modelsPath, model) {
  return path.join(modelsPath, validModel(model));
}

async function isModelReady(modelsPath, model) {
  const target = modelPath(modelsPath, model);
  return Promise.all(["config.json", "model.bin", "tokenizer.json"].map((file) => pathExists(path.join(target, file))))
    .then((checks) => checks.every(Boolean));
}

async function directorySize(target) {
  if (!await pathExists(target)) return 0;
  let total = 0;
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    total += entry.isDirectory() ? await directorySize(child) : Number((await stat(child)).size);
  }
  return total;
}

async function resolveRuntime(options) {
  if (options.bundledRunnerPath && await pathExists(options.bundledRunnerPath)) {
    return { kind: "bundled", executable: options.bundledRunnerPath, prefixArgs: [], ready: true };
  }
  const python = await findPython();
  if (python?.supported && python.fasterWhisperInstalled) {
    return { kind: "development", executable: python.executable, prefixArgs: [options.devRunnerPath], ready: true };
  }
  return { kind: options.isPackaged ? "missing" : "development", executable: "", prefixArgs: [], ready: false };
}

function withoutProgress(text) {
  return String(text || "").split("\n").filter((line) => !line.startsWith("PROGRESS ")).join("\n").trim();
}

async function runEngine(args, options, execution = {}) {
  const runtime = await resolveRuntime(options);
  if (!runtime.ready) throw new Error(options.isPackaged ? "安装包缺少本地 AI 运行时，请重新安装 DashCut 极剪" : "开发环境尚未安装 faster-whisper");
  const running = execFileAsync(runtime.executable, [...runtime.prefixArgs, ...args], {
    timeout: execution.timeout ?? 6 * 60 * 60 * 1000,
    windowsHide: true,
    maxBuffer: 100 * 1024 * 1024,
  });
  // The engine streams "PROGRESS <0..1>" lines on stderr while it works.
  let pending = "";
  running.child.stderr?.on("data", (chunk) => {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop();
    for (const line of lines) {
      const match = /^PROGRESS ([\d.]+)$/.exec(line.trim());
      if (match) execution.onProgress?.(Number(match[1]));
    }
  });
  let stdout;
  let stderr;
  try { ({ stdout, stderr } = await running); }
  catch (error) { throw new Error(withoutProgress(error.stderr) || error.message); }
  try { return JSON.parse(stdout); }
  catch { throw new Error(withoutProgress(stderr) || "本地 AI 运行时返回了无效结果"); }
}

async function getRuntimeStatus(options) {
  const runtime = await resolveRuntime(options);
  if (!runtime.ready) return { ...runtime, info: null };
  try {
    const info = await runEngine(["--runtime-info"], options, { timeout: 30_000 });
    return { ...runtime, info };
  } catch (error) {
    return { ...runtime, ready: false, info: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function getModels(options) {
  return Promise.all(Object.entries(MODEL_CATALOG).map(async ([id, metadata]) => ({
    id,
    ...metadata,
    installed: await isModelReady(options.modelsPath, id),
    sizeBytes: await directorySize(modelPath(options.modelsPath, id)),
  })));
}

async function installModel(model, options) {
  validModel(model);
  if (await isModelReady(options.modelsPath, model)) return { model, alreadyInstalled: true };
  await mkdir(options.modelsPath, { recursive: true });
  try {
    return await runEngine(["--download-model", "--model", model, "--model-root", options.modelsPath], options);
  } catch (error) {
    await rm(modelPath(options.modelsPath, model), { recursive: true, force: true });
    throw error;
  }
}

async function removeModel(model, options) {
  await rm(modelPath(options.modelsPath, validModel(model)), { recursive: true, force: true });
  return { model, removed: true };
}

module.exports = { MODEL_CATALOG, getModels, getRuntimeStatus, installModel, isModelReady, removeModel, runEngine };
