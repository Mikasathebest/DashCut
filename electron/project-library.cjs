/* eslint-disable @typescript-eslint/no-require-imports */
// Start-screen data: summaries of recent projects and other *.dashcut files on disk,
// each with a small preview (the saved cover / first frame, or a frame grabbed on demand).
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync } = require("node:fs");
const { mkdir, readFile, readdir, stat } = require("node:fs/promises");
const path = require("node:path");
const { withResolvedPaths } = require("./project-store.cjs");

const skipDirectories = new Set(["node_modules", "Library", "Applications", "AppData", "Program Files", "Program Files (x86)", "Windows", "System", "$RECYCLE.BIN"]);

/** Breadth-first search for *.dashcut files below `roots`, bounded in depth, folders visited and results. */
async function findProjectFiles(roots, { maxDepth = 3, maxDirectories = 600, limit = 60 } = {}) {
  const found = new Set();
  const seen = new Set();
  const queue = roots.filter(Boolean).map((root) => ({ dir: path.resolve(root), depth: 0 }));
  let visited = 0;
  while (queue.length && visited < maxDirectories && found.size < limit) {
    const { dir, depth } = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);
    visited += 1;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".dashcut")) found.add(full);
      else if (entry.isDirectory() && depth < maxDepth && !skipDirectories.has(entry.name) && !entry.name.endsWith(".app")) queue.push({ dir: full, depth: depth + 1 });
      if (found.size >= limit) break;
    }
  }
  return [...found];
}

/** First visual clip on the main track (or any track), with the source time to show. */
function firstFrameSource(doc) {
  const tracks = Array.isArray(doc.tracks) ? doc.tracks : [];
  const clips = Array.isArray(doc.clips) ? doc.clips : [];
  const assets = new Map((Array.isArray(doc.assets) ? doc.assets : []).map((asset) => [asset.id, asset]));
  const main = tracks.find((track) => track.main)?.id;
  const visual = clips.filter((clip) => ["video", "image", "gif"].includes(assets.get(clip.assetId)?.kind));
  const ordered = [...visual.filter((clip) => clip.trackId === main), ...visual.filter((clip) => clip.trackId !== main)].sort((a, b) => (a.trackId === main) === (b.trackId === main) ? a.start - b.start : a.trackId === main ? -1 : 1);
  const clip = ordered[0];
  if (!clip) return null;
  const asset = assets.get(clip.assetId);
  if (!asset?.absolutePath || !existsSync(asset.absolutePath)) return null;
  const time = asset.kind === "video" ? (clip.freezeAt ?? clip.in ?? 0) : 0;
  return { file: asset.absolutePath, kind: asset.kind, time };
}

function grabFrame(ffmpegPath, file, time, output) {
  return new Promise((resolve) => {
    const args = ["-hide_banner", "-nostdin", "-y", "-ss", String(Math.max(0, time)), "-i", file, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", output];
    let child;
    try {
      child = spawn(ffmpegPath, args, { windowsHide: true, stdio: "ignore" });
    } catch {
      return resolve(false);
    }
    const timer = setTimeout(() => child.kill(), 8000);
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0 && existsSync(output)); });
  });
}

/**
 * Title, dates and a preview for one project file. The preview is the image saved with the
 * project; older files fall back to a cached frame of their first clip.
 */
async function summarizeProject(file, { ffmpegPath, cacheDir, encodeImage } = {}) {
  const info = await stat(file);
  const raw = JSON.parse(await readFile(file, "utf8"));
  if (!raw || typeof raw !== "object" || raw.app !== "DashCut") throw new Error("not a DashCut project");
  const { doc } = withResolvedPaths({ ...raw, assets: Array.isArray(raw.assets) ? raw.assets : [] }, file);
  const clips = Array.isArray(doc.clips) ? doc.clips : [];
  const duration = clips.reduce((end, clip) => Math.max(end, (clip.start ?? 0) + Math.max(0, ((clip.out ?? 0) - (clip.in ?? 0)) / (clip.speed || 1))), 0);
  const summary = {
    path: file,
    title: typeof doc.meta?.title === "string" && doc.meta.title.trim() ? doc.meta.title : path.basename(file, ".dashcut"),
    modifiedAt: doc.meta?.modifiedAt ?? info.mtime.toISOString(),
    ratio: doc.canvas?.ratio === "9:16" ? "9:16" : "16:9",
    duration,
    clipCount: clips.length,
    preview: typeof doc.preview === "string" && doc.preview.startsWith("data:image/") ? doc.preview : "",
  };
  if (summary.preview || !cacheDir) return summary;
  const source = firstFrameSource(doc);
  if (!source) return summary;
  // Stills are shown as they are; video frames are grabbed once per file version.
  if (source.kind !== "video") {
    summary.preview = encodeImage ? await encodeImage(source.file).catch(() => "") : "";
    return summary;
  }
  if (!ffmpegPath) return summary;
  const key = createHash("sha1").update(`${file}|${info.mtimeMs}|${source.file}|${source.time}`).digest("hex").slice(0, 20);
  const cached = path.join(cacheDir, `${key}.jpg`);
  await mkdir(cacheDir, { recursive: true });
  if (existsSync(cached) || await grabFrame(ffmpegPath, source.file, source.time, cached)) {
    summary.preview = `data:image/jpeg;base64,${(await readFile(cached)).toString("base64")}`;
  }
  return summary;
}

/** Recent projects (in opened order) plus other projects found in the usual folders. */
async function projectLibrary({ recent, roots, ffmpegPath, cacheDir, encodeImage, scan = findProjectFiles }) {
  const summarize = (file) => summarizeProject(file, { ffmpegPath, cacheDir, encodeImage }).catch(() => null);
  const recentItems = await Promise.all(recent.map(async (item) => {
    if (!item.exists) return { path: item.path, title: item.title, openedAt: item.openedAt, missing: true };
    const summary = await summarize(item.path);
    return summary ? { ...summary, openedAt: item.openedAt } : { path: item.path, title: item.title, openedAt: item.openedAt, missing: true };
  }));
  const known = new Set(recent.map((item) => path.resolve(item.path)));
  // Folders holding recent projects are searched first; they are where new ones usually land.
  const searchRoots = [...new Set([...recent.map((item) => path.dirname(item.path)), ...roots])].filter((root) => existsSync(root));
  const files = (await scan(searchRoots)).filter((file) => !known.has(path.resolve(file)));
  const found = (await Promise.all(files.map(summarize))).filter(Boolean).sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
  return { recent: recentItems, found };
}

module.exports = { findProjectFiles, firstFrameSource, projectLibrary, summarizeProject };
