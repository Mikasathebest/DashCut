/* eslint-disable @typescript-eslint/no-require-imports */
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { statfsSync } = require("node:fs");

const execFileAsync = promisify(execFile);

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function run(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: 3500,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function findPython() {
  for (const command of process.platform === "win32" ? ["python", "py"] : ["python3", "python"]) {
    const args = command === "py" ? ["-3", "-c", "import sys;print(sys.executable);print('.'.join(map(str,sys.version_info[:3])))"] : ["-c", "import sys;print(sys.executable);print('.'.join(map(str,sys.version_info[:3])))"];
    const output = await run(command, args);
    if (!output) continue;
    const [executable, version] = output.split(/\r?\n/);
    const majorMinor = version.split(".").slice(0, 2).map(Number);
    const supported = majorMinor[0] > 3 || (majorMinor[0] === 3 && majorMinor[1] >= 9);
    const checkArgs = command === "py"
      ? ["-3", "-c", "import faster_whisper,ctranslate2;print(ctranslate2.get_cuda_device_count())"]
      : ["-c", "import faster_whisper,ctranslate2;print(ctranslate2.get_cuda_device_count())"];
    const localRuntime = await run(command, checkArgs);
    return {
      command,
      executable,
      version,
      supported,
      fasterWhisperInstalled: Boolean(localRuntime),
      cudaRuntimeReady: Number(localRuntime) > 0,
    };
  }
  return null;
}

async function detectGpus() {
  const nvidia = await run("nvidia-smi", [
    "--query-gpu=name,memory.total,driver_version",
    "--format=csv,noheader,nounits",
  ]);
  if (nvidia) {
    return nvidia.split(/\r?\n/).map((line) => {
      const [name, memoryMb, driver] = line.split(",").map((value) => value.trim());
      return {
        name,
        vendor: "NVIDIA",
        memoryGb: round(Number(memoryMb) / 1024),
        driver,
        fasterWhisperAcceleration: true,
      };
    });
  }

  if (process.platform === "darwin") {
    const json = await run("system_profiler", ["SPDisplaysDataType", "-json"]);
    try {
      const displays = JSON.parse(json).SPDisplaysDataType || [];
      return displays.map((display) => ({
        name: display.sppci_model || display._name || "Apple GPU",
        vendor: /apple/i.test(display.sppci_model || "") ? "Apple" : "Other",
        memoryGb: null,
        driver: display.spdisplays_metal || "Metal",
        fasterWhisperAcceleration: false,
      }));
    } catch {
      return [];
    }
  }

  return [];
}

async function detectAvailableMemoryGb() {
  if (process.platform !== "darwin") return round(os.freemem() / 1024 ** 3);
  const output = await run("vm_stat", []);
  const pageSize = Number(output.match(/page size of (\d+) bytes/i)?.[1] || 4096);
  const reclaimable = ["Pages free", "Pages inactive", "Pages speculative", "Pages purgeable"];
  const pages = reclaimable.reduce((total, label) => {
    const value = output.match(new RegExp(`${label}:\\s+(\\d+)\\.`))?.[1];
    return total + Number(value || 0);
  }, 0);
  return pages ? round(pages * pageSize / 1024 ** 3) : round(os.freemem() / 1024 ** 3);
}

function assessHardware(profile) {
  const cudaGpu = profile.gpus.find((gpu) => gpu.fasterWhisperAcceleration);
  const vram = cudaGpu?.memoryGb || 0;
  const minimum = profile.memory.totalGb >= 8 && profile.cpu.logicalCores >= 4 && profile.diskFreeGb >= 4;
  const recommended = profile.memory.totalGb >= 16 && profile.cpu.logicalCores >= 8 && profile.diskFreeGb >= 10 && vram >= 8;

  let tier = "unsupported";
  let model = "cloud";
  let computeType = "none";
  if (minimum) {
    tier = recommended ? "recommended" : "minimum";
    model = recommended ? "large-v3" : "small";
    computeType = recommended ? "float16" : "int8";
  }

  const blockers = [];
  const notes = [];
  if (profile.memory.totalGb < 8) blockers.push("系统内存不足 8 GB");
  if (profile.cpu.logicalCores < 4) blockers.push("CPU 少于 4 个逻辑核心");
  if (profile.diskFreeGb < 4) blockers.push("可用磁盘空间不足 4 GB");
  if (!cudaGpu) notes.push("未检测到可用于 faster-whisper 的 NVIDIA CUDA GPU，将使用 CPU 推理");
  if (process.platform === "darwin") notes.push("faster-whisper/CTranslate2 不能使用 Apple GPU，将在 Apple Silicon 或 Intel CPU 上运行");
  if (!profile.runtime?.ready) blockers.push("本地 AI 运行时不可用，请重新安装 DashCat");
  if (cudaGpu && Number(profile.runtime?.info?.cudaDeviceCount) < 1) notes.push("检测到 NVIDIA GPU，但当前 CUDA 运行时不可用；将自动使用 CPU，无需手动安装依赖");

  return { tier, model, computeType, blockers, notes };
}

async function getHardwareProfile(storagePath, runtime = null) {
  const cpus = os.cpus();
  const disk = statfsSync(storagePath);
  const availableMemoryGb = await detectAvailableMemoryGb();
  const profile = {
    platform: process.platform,
    arch: process.arch,
    cpu: {
      model: cpus[0]?.model?.trim() || "Unknown CPU",
      logicalCores: cpus.length,
    },
    memory: {
      totalGb: round(os.totalmem() / 1024 ** 3),
      freeGb: availableMemoryGb,
    },
    diskFreeGb: round(Number(disk.bavail) * Number(disk.bsize) / 1024 ** 3),
    gpus: await detectGpus(),
    runtime,
  };
  return { ...profile, assessment: assessHardware(profile) };
}

module.exports = { assessHardware, findPython, getHardwareProfile };
