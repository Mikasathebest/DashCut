import { access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const projectDir = path.resolve(import.meta.dirname, "..");
const runtimeDir = path.join(projectDir, "media-runtime", "current");
const executable = path.join(runtimeDir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const runtimeEnvironment = await readFile(path.join(projectDir, "scripts", "ffmpeg-runtime.env"), "utf8");
const pinnedVersion = runtimeEnvironment.match(/^FFMPEG_VERSION=(.+)$/m)?.[1];
const pinnedSha256 = runtimeEnvironment.match(/^FFMPEG_SHA256=([a-f\d]{64})$/m)?.[1];

if (!pinnedVersion || !pinnedSha256) throw new Error("Pinned FFmpeg version or SHA-256 is missing");

await Promise.all([
  access(executable),
  access(path.join(runtimeDir, "FFMPEG-BUILD-CONFIG.txt")),
  access(path.join(runtimeDir, "FFMPEG-LGPL-2.1.txt")),
  access(path.join(runtimeDir, "FFMPEG-SOURCE.txt")),
  access(path.join(runtimeDir, "RUNTIME-FILES.txt")),
]);

function run(...args) {
  const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `FFmpeg exited with ${result.status}`);
  return `${result.stdout}\n${result.stderr}`;
}

const buildConfiguration = run("-hide_banner", "-buildconf");
if (buildConfiguration.includes("--enable-nonfree")) throw new Error("FFmpeg runtime enables nonfree code and cannot be distributed");
if (buildConfiguration.includes("--enable-gpl")) throw new Error("FFmpeg runtime enables GPL code instead of the required LGPL configuration");
if (!buildConfiguration.includes("--enable-libass")) throw new Error("FFmpeg runtime is missing libass subtitle rendering");

const version = run("-hide_banner", "-version");
if (!version.includes(`ffmpeg version ${pinnedVersion}`)) throw new Error(`FFmpeg runtime does not match pinned version ${pinnedVersion}`);

const encoders = run("-hide_banner", "-encoders");
const requiredEncoder = process.platform === "darwin" ? "h264_videotoolbox" : process.platform === "win32" ? "h264_mf" : "";
if (requiredEncoder && !encoders.includes(requiredEncoder)) throw new Error(`FFmpeg runtime is missing ${requiredEncoder}`);

const filters = run("-hide_banner", "-filters");
if (!/^\s*\S+\s+ass\s+/m.test(filters)) throw new Error("FFmpeg runtime is missing the ass subtitle filter");

const sourceNotice = await readFile(path.join(runtimeDir, "FFMPEG-SOURCE.txt"), "utf8");
if (!sourceNotice.includes("ffmpeg.org/releases/")) throw new Error("FFmpeg source notice does not link to the corresponding source archive");
if (!sourceNotice.includes(`FFmpeg version: ${pinnedVersion}`) || !sourceNotice.includes(`SHA-256: ${pinnedSha256}`)) {
  throw new Error("FFmpeg source notice does not match the pinned version and checksum");
}

console.log(`Verified LGPL FFmpeg runtime with ${requiredEncoder || "platform encoder"}: ${executable}`);
