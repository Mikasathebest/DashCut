/* eslint-disable @typescript-eslint/no-require-imports */
const { stat } = require("node:fs/promises");
const path = require("node:path");
const { isModelReady, runEngine } = require("./model-manager.cjs");

async function transcribeLocal(request, options) {
  if (!Array.isArray(request?.clips) || request.clips.length === 0) throw new Error("没有可识别的视频片段");
  const model = ["small", "medium", "large-v3", "turbo"].includes(request.model) ? request.model : "small";
  if (!await isModelReady(options.modelsPath, model)) throw new Error(`模型 ${model} 尚未下载安装`);
  const runtimeStatus = await options.getRuntimeStatus();
  const device = request.device === "cuda" && Number(runtimeStatus.info?.cudaDeviceCount) > 0 ? "cuda" : "cpu";
  const computeType = device === "cuda" ? (request.computeType === "float16" ? "float16" : "int8_float16") : "int8";

  const hotwords = typeof request.hotwords === "string" ? request.hotwords.replace(/[\r\n]+/g, " ").trim().slice(0, 500) : "";
  const results = [];
  for (const [index, clip] of request.clips.entries()) {
    const report = (fraction) => options.onProgress?.({ progress: (index + fraction) / request.clips.length, stage: `本地识别 ${index + 1}/${request.clips.length}` });
    report(0);
    if (!Number.isInteger(clip.id) || typeof clip.path !== "string" || !path.isAbsolute(clip.path)) throw new Error("视频路径无效");
    const file = await stat(clip.path);
    if (!file.isFile()) throw new Error(`找不到视频：${path.basename(clip.path)}`);
    const parsed = await runEngine([
      "--input", clip.path,
      "--model", model,
      "--device", device,
      "--compute-type", computeType,
      "--model-root", options.modelsPath,
      // Only sent when set, so runtimes built before --hotwords existed keep working.
      ...(hotwords ? ["--hotwords", hotwords] : []),
    ], options, { onProgress: report });
    results.push({ clipId: clip.id, ...parsed });
  }
  return { model, device, computeType, results };
}

module.exports = { transcribeLocal };
