/* eslint-disable @typescript-eslint/no-require-imports */
const { existsSync } = require("node:fs");
const { mkdir, readdir, readFile, rename, rm, stat, writeFile } = require("node:fs/promises");
const path = require("node:path");

const recentLimit = 12;

/** Writes through a temp file and rename so a crash never leaves a half-written project. */
async function atomicWrite(target, contents) {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temp, contents, "utf8");
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

function toPortable(relative) {
  return relative.split(path.sep).join("/");
}

/** Stores each asset path relative to the project folder (when on the same volume) plus the absolute path. */
function withStoredPaths(doc, projectPath) {
  const folder = path.dirname(projectPath);
  return {
    ...doc,
    assets: doc.assets.map((asset) => {
      const absolutePath = asset.absolutePath || asset.path;
      if (!absolutePath) return { ...asset, path: "", absolutePath: "" };
      const relative = path.relative(folder, absolutePath);
      const usable = relative && !path.isAbsolute(relative) && path.parse(folder).root === path.parse(absolutePath).root;
      return { ...asset, path: usable ? toPortable(relative) : absolutePath, absolutePath };
    }),
  };
}

/** Resolves stored paths, preferring the relative path so moved project folders keep working. */
function withResolvedPaths(doc, projectPath) {
  const folder = path.dirname(projectPath);
  const missing = [];
  const assets = doc.assets.map((asset) => {
    const candidates = [];
    if (asset.path) candidates.push(path.isAbsolute(asset.path) ? asset.path : path.resolve(folder, ...asset.path.split("/")));
    if (asset.absolutePath) candidates.push(asset.absolutePath);
    const found = candidates.find((candidate) => existsSync(candidate));
    if (!found) missing.push(asset.id);
    return { ...asset, absolutePath: found ?? asset.absolutePath ?? "" };
  });
  return { doc: { ...doc, assets }, missing };
}

async function saveProject(projectPath, doc) {
  await atomicWrite(projectPath, `${JSON.stringify(withStoredPaths(doc, projectPath), null, 2)}\n`);
  return projectPath;
}

async function loadProject(projectPath) {
  const raw = JSON.parse(await readFile(projectPath, "utf8"));
  return withResolvedPaths(raw, projectPath);
}

/** Looks for files with the same names as missing media next to a newly relinked file. */
function findSiblings(directory, names) {
  const found = {};
  for (const name of names) {
    const candidate = path.join(directory, name);
    if (existsSync(candidate)) found[name] = candidate;
  }
  return found;
}

function createRecentList(file) {
  async function read() {
    try {
      const items = JSON.parse(await readFile(file, "utf8"));
      return Array.isArray(items) ? items.filter((item) => item && typeof item.path === "string") : [];
    } catch {
      return [];
    }
  }
  return {
    async list() {
      const items = await read();
      return items.map((item) => ({ ...item, exists: existsSync(item.path) }));
    },
    async add(entry) {
      const items = (await read()).filter((item) => item.path !== entry.path);
      const next = [{ ...entry, openedAt: new Date().toISOString() }, ...items].slice(0, recentLimit);
      await atomicWrite(file, JSON.stringify(next, null, 2));
      return next;
    },
    async remove(target) {
      const next = (await read()).filter((item) => item.path !== target);
      await atomicWrite(file, JSON.stringify(next, null, 2));
      return next;
    },
  };
}

/** Autosave snapshots live outside user folders and are removed after an explicit save or a clean close. */
function createAutosave(directory) {
  const fileFor = (id) => path.join(directory, `${String(id).replace(/[^\w-]/g, "_")}.json`);
  return {
    async write(id, payload) {
      await atomicWrite(fileFor(id), JSON.stringify({ ...payload, savedAt: new Date().toISOString() }));
    },
    async clear(id) {
      await rm(fileFor(id), { force: true });
    },
    async list() {
      if (!existsSync(directory)) return [];
      const entries = [];
      for (const name of await readdir(directory)) {
        if (!name.endsWith(".json")) continue;
        const file = path.join(directory, name);
        try {
          const payload = JSON.parse(await readFile(file, "utf8"));
          // Skip snapshots that are older than the saved project they belong to.
          if (payload.projectPath && existsSync(payload.projectPath) && (await stat(payload.projectPath)).mtimeMs >= Date.parse(payload.savedAt)) {
            await rm(file, { force: true });
            continue;
          }
          entries.push({ id: payload.document?.meta?.id ?? name, title: payload.document?.meta?.title ?? "未命名项目", savedAt: payload.savedAt, projectPath: payload.projectPath ?? "" });
        } catch {
          await rm(file, { force: true });
        }
      }
      return entries.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
    },
    async read(id) {
      const payload = JSON.parse(await readFile(fileFor(id), "utf8"));
      const { doc, missing } = withResolvedPaths(payload.document, payload.projectPath || path.join(directory, "recovered.dashcut"));
      return { document: doc, projectPath: payload.projectPath ?? "", missing };
    },
  };
}

module.exports = { atomicWrite, createAutosave, createRecentList, findSiblings, loadProject, saveProject, withResolvedPaths, withStoredPaths };
