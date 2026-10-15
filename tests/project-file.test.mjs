import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { createClip, createProject, mainTrack, placeClip } from "../app/editor/model.ts";
import { buildDocument, migrateDocument, projectSchemaVersion, readDocument } from "../app/editor/project-file.ts";

const require = createRequire(import.meta.url);
const { atomicWrite, createAutosave, createRecentList, findSiblings, loadProject, saveProject } = require("../electron/project-store.cjs");

function sampleState(folder) {
  const video = { id: "asset-1", name: "talk.mp4", kind: "video", url: "blob:x", sourcePath: path.join(folder, "media", "talk.mp4"), duration: 6, width: 1920, height: 1080, hasAudio: true, thumbnail: "data:", frames: ["data:"], peaks: [0.5], peaksPerSecond: 50 };
  let project = createProject();
  project = placeClip(project, createClip(video, mainTrack(project).id, 0), mainTrack(project).id, 0, { magnet: true, linkage: true });
  project = { ...project, markers: [{ id: "m1", time: 2 }], subtitles: [{ id: 1, start: 0.5, end: 1.5, zh: "你好", en: "Hello" }] };
  return {
    id: "project-1", title: "测试项目", createdAt: "2026-10-14T00:00:00.000Z", ratio: "9:16", project, assets: [video],
    captionStyle: { fontFamily: "Arial", fontSize: 30, color: "#ffffff", outlineColor: "#000000", outlineWidth: 2, backgroundOpacity: 40 },
    captionMode: "zh", exportSettings: { resolution: 1080, fps: 60, platform: "youtube" }, cover: { background: "#000000", layers: [
      { id: "bg", kind: "image", src: "data:image/png;base64,AA==", x: 0, y: 0, w: 1, h: 1, fit: "cover", aspect: 1.5, background: true, frameTime: 1.2 },
      { id: "t1", kind: "text", text: "标题", x: 0.1, y: 0.2, size: 0.12, font: "Arial", color: "#ffffff", bold: true, italic: false, align: "center", stroke: "#000000", strokeWidth: 0.1, shadow: false, box: null },
    ] },
  };
}

test("document round-trips the editor state without preview caches", () => {
  const state = sampleState("/work");
  const doc = buildDocument(state, new Date("2026-10-14T12:00:00Z"));
  assert.equal(doc.schemaVersion, projectSchemaVersion);
  assert.equal(doc.meta.modifiedAt, "2026-10-14T12:00:00.000Z");
  assert.equal("thumbnail" in doc.assets[0], false);
  const restored = readDocument(migrateDocument(JSON.parse(JSON.stringify(doc))), (file) => `media://${file}`);
  assert.deepEqual(restored.project, state.project);
  assert.equal(restored.assets[0].url, "media:///work/media/talk.mp4");
  assert.deepEqual(restored.assets[0].frames, []);
  for (const key of ["title", "ratio", "captionStyle", "captionMode", "exportSettings", "cover"]) assert.deepEqual(restored[key], state[key]);
});

test("migrates version 1 documents and rejects foreign or future files", () => {
  const doc = buildDocument(sampleState("/work"));
  const v1 = { ...doc, schemaVersion: 1 };
  delete v1.captionMode;
  delete v1.exportSettings;
  delete v1.transitions;
  const migrated = migrateDocument(v1);
  assert.equal(migrated.schemaVersion, projectSchemaVersion);
  assert.equal(migrated.captionMode, "both");
  assert.deepEqual(migrated.exportSettings, { resolution: 1080, fps: 60, platform: "bilibili" });
  assert.throws(() => migrateDocument({ ...doc, app: "Other" }), /不是 DashCut/);
  assert.throws(() => migrateDocument({ ...doc, schemaVersion: projectSchemaVersion + 1 }), /更新版本/);
  assert.throws(() => migrateDocument({ ...doc, clips: [{ ...doc.clips[0], assetId: "nope" }] }), /不存在的素材/);
});

test("saves atomically with relative media paths and reopens after the folder moves", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dashcut-project-"));
  try {
    const folder = path.join(root, "show");
    await mkdir(path.join(folder, "media"), { recursive: true });
    await writeFile(path.join(folder, "media", "talk.mp4"), "video");
    const file = path.join(folder, "show.dashcut");
    await saveProject(file, buildDocument(sampleState(folder)));
    const stored = JSON.parse(await readFile(file, "utf8"));
    assert.equal(stored.assets[0].path, "media/talk.mp4");
    // Move the whole folder: the absolute path breaks, the relative one still resolves.
    const moved = path.join(root, "moved");
    await rename(folder, moved);
    const { doc, missing } = await loadProject(path.join(moved, "show.dashcut"));
    assert.deepEqual(missing, []);
    assert.equal(doc.assets[0].absolutePath, path.join(moved, "media", "talk.mp4"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports missing media and finds same-named siblings for relinking", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dashcut-missing-"));
  try {
    const file = path.join(root, "a.dashcut");
    await saveProject(file, buildDocument(sampleState(path.join(root, "gone"))));
    const { missing } = await loadProject(file);
    assert.deepEqual(missing, ["asset-1"]);
    await mkdir(path.join(root, "found"));
    await writeFile(path.join(root, "found", "b-roll.mov"), "x");
    assert.deepEqual(findSiblings(path.join(root, "found"), ["b-roll.mov", "other.mov"]), { "b-roll.mov": path.join(root, "found", "b-roll.mov") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomic writes leave no temp files; recent list and autosave recovery behave", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dashcut-store-"));
  try {
    await atomicWrite(path.join(root, "x.json"), "{}");
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(root), ["x.json"]);
    const recent = createRecentList(path.join(root, "recent.json"));
    await recent.add({ path: "/a.dashcut", title: "A" });
    await recent.add({ path: "/b.dashcut", title: "B" });
    await recent.add({ path: "/a.dashcut", title: "A2" });
    assert.deepEqual((await recent.list()).map((item) => item.title), ["A2", "B"]);
    const autosave = createAutosave(path.join(root, "autosave"));
    const doc = buildDocument(sampleState(root));
    await autosave.write(doc.meta.id, { document: doc, projectPath: "" });
    assert.deepEqual((await autosave.list()).map((item) => item.title), ["测试项目"]);
    assert.equal((await autosave.read(doc.meta.id)).document.meta.id, "project-1");
    // A snapshot older than its saved project file is stale and dropped.
    const saved = path.join(root, "saved.dashcut");
    await autosave.write("stale", { document: { ...doc, meta: { ...doc.meta, id: "stale" } }, projectPath: saved });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await saveProject(saved, doc);
    assert.deepEqual((await autosave.list()).map((item) => item.id), ["project-1"]);
    await autosave.clear(doc.meta.id);
    assert.deepEqual(await autosave.list(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transcripts and separation stems survive a save and reopen", async () => {
  const state = sampleState("/work");
  const words = [{ start: 0, end: 0.5, text: "你好", prob: 0.9 }];
  state.project = { ...state.project, transcripts: { "asset-1": { language: "zh", source: "local", words, sentences: [{ start: 0, end: 0.5 }] } }, stems: { "asset-1": { voice: "/cache/v.wav", background: "/cache/b.wav" } } };
  const restored = readDocument(migrateDocument(JSON.parse(JSON.stringify(buildDocument(state)))), (file) => file);
  assert.deepEqual(restored.project.transcripts, state.project.transcripts);
  assert.deepEqual(restored.project.stems, state.project.stems);
});
