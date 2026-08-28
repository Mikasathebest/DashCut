import { existsSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pythonCandidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];

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
    const prefix = command === "py" ? ["-3"] : [];
    const result = spawnSync(command, [...prefix, "-c", "import sys;print(sys.executable)"], {
      cwd: rootDir,
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status === 0 && result.stdout.trim()) return { command, prefix };
  }
  throw new Error("Python 3 was not found on the build machine");
}

const bootstrapPython = findPython();
const runtimeDir = path.join(rootDir, "local-runtime");
const runtimeBundle = path.join(runtimeDir, "dashcat-transcribe");
const workDir = path.join(rootDir, ".pyinstaller");
const venvDir = path.join(rootDir, ".runtime-venv");
const venvPython = process.platform === "win32" ? path.join(venvDir, "Scripts", "python.exe") : path.join(venvDir, "bin", "python");
rmSync(runtimeBundle, { recursive: true, force: true });
rmSync(workDir, { recursive: true, force: true });
await mkdir(runtimeDir, { recursive: true });

if (!existsSync(venvPython)) run(bootstrapPython.command, [...bootstrapPython.prefix, "-m", "venv", venvDir]);
run(venvPython, ["-m", "pip", "install", "--disable-pip-version-check", "-r", path.join(rootDir, "local-engine", "build-requirements.txt")]);
run(venvPython, [
  "-m", "PyInstaller",
  "--noconfirm",
  "--clean",
  "--onedir",
  "--name", "dashcat-transcribe",
  "--distpath", runtimeDir,
  "--workpath", path.join(workDir, "work"),
  "--specpath", path.join(workDir, "spec"),
  "--collect-all", "faster_whisper",
  "--collect-all", "ctranslate2",
  "--collect-all", "av",
  "--collect-all", "tokenizers",
  "--collect-all", "huggingface_hub",
  path.join(rootDir, "local-engine", "transcribe.py"),
]);

const executable = path.join(runtimeBundle, process.platform === "win32" ? "dashcat-transcribe.exe" : "dashcat-transcribe");
if (!existsSync(executable)) throw new Error(`Runtime executable was not produced: ${executable}`);
run(executable, ["--runtime-info"]);
console.log(`\nSelf-contained local AI runtime ready: ${runtimeBundle}`);
