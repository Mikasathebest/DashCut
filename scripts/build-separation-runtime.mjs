// Builds the optional voice / background separation runtime (Demucs + PyTorch CPU/MPS)
// into local-runtime/dashcut-separate. Model weights are not bundled; the app downloads
// them on demand with `dashcut-separate --download-model`.
import { existsSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pythonCandidates = process.env.DASHCUT_BUILD_PYTHON
  ? [process.env.DASHCUT_BUILD_PYTHON]
  : process.platform === "win32" ? ["python", "py"] : ["python3", "python"];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function findPython() {
  for (const command of pythonCandidates) {
    const prefix = command === "py" ? ["-3.11"] : [];
    const result = spawnSync(command, [...prefix, "-c", "import sys;print('%d.%d' % sys.version_info[:2])"], {
      cwd: rootDir,
      encoding: "utf8",
      windowsHide: true,
    });
    // The pinned torch / numpy wheels are chosen for CPython 3.11.
    if (result.status === 0 && result.stdout.trim() === "3.11") return { command, prefix };
  }
  throw new Error("Python 3.11 was not found on the build machine (set DASHCUT_BUILD_PYTHON)");
}

const bootstrapPython = findPython();
const runtimeDir = path.join(rootDir, "local-runtime");
const runtimeBundle = path.join(runtimeDir, "dashcut-separate");
const workDir = path.join(rootDir, ".pyinstaller-separate");
const venvDir = path.join(rootDir, ".separation-venv");
const venvPython = process.platform === "win32" ? path.join(venvDir, "Scripts", "python.exe") : path.join(venvDir, "bin", "python");
rmSync(runtimeBundle, { recursive: true, force: true });
rmSync(workDir, { recursive: true, force: true });
await mkdir(runtimeDir, { recursive: true });

if (!existsSync(venvPython)) run(bootstrapPython.command, [...bootstrapPython.prefix, "-m", "venv", venvDir]);
run(venvPython, ["-m", "pip", "install", "--disable-pip-version-check", "-r", path.join(rootDir, "local-engine", "separate-requirements.txt")]);
run(venvPython, [
  "-m", "PyInstaller",
  "--noconfirm",
  "--clean",
  "--onedir",
  "--name", "dashcut-separate",
  "--distpath", runtimeDir,
  "--workpath", path.join(workDir, "work"),
  "--specpath", path.join(workDir, "spec"),
  // The checkpoint pickle references demucs.htdemucs; only the inference modules are bundled
  // (no demucs.hf / demucs.audio / training code, so no Hugging Face or MP3 encoder stacks).
  "--hidden-import", "demucs.htdemucs",
  "--hidden-import", "demucs.apply",
  "--hidden-import", "demucs.repo",
  // The htdemucs checkpoint was pickled with numpy 1.x and references numpy.core.multiarray,
  // a numpy 2 compatibility shim PyInstaller does not pick up on its own.
  "--hidden-import", "numpy.core.multiarray",
  // Training / tooling stacks the inference path never touches.
  "--exclude-module", "tkinter",
  "--exclude-module", "matplotlib",
  "--exclude-module", "IPython",
  "--exclude-module", "torchaudio",
  "--exclude-module", "torchvision",
  "--exclude-module", "tensorboard",
  "--exclude-module", "dora",
  "--exclude-module", "hydra",
  "--exclude-module", "diffq",
  "--exclude-module", "huggingface_hub",
  "--exclude-module", "hf_xet",
  "--exclude-module", "safetensors",
  "--exclude-module", "sphn",
  "--exclude-module", "lameenc",
  path.join(rootDir, "local-engine", "separate.py"),
]);

const executable = path.join(runtimeBundle, process.platform === "win32" ? "dashcut-separate.exe" : "dashcut-separate");
if (!existsSync(executable)) throw new Error(`Runtime executable was not produced: ${executable}`);
run(executable, ["--runtime-info"]);
console.log(`\nSelf-contained voice separation runtime ready: ${runtimeBundle}`);
