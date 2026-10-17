import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { findProjectFiles, firstFrameSource, projectLibrary, summarizeProject } = require("../electron/project-library.cjs");

const doc = (title, extra = {}) => JSON.stringify({ schemaVersion: 2, app: "DashCut", meta: { id: title, title, createdAt: "2026-01-01T00:00:00.000Z", modifiedAt: "2026-01-02T00:00:00.000Z" }, canvas: { ratio: "16:9", fps: 30 }, assets: [], tracks: [{ id: "main", kind: "video", main: true }], clips: [], ...extra });

test("finds .dashcut files within the depth limit and skips hidden and package folders", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dashcut-library-"));
  try {
    await mkdir(path.join(root, "a", "b"), { recursive: true });
    await mkdir(path.join(root, ".hidden"), { recursive: true });
    await mkdir(path.join(root, "node_modules"), { recursive: true });
    await mkdir(path.join(root, "x", "y", "z", "deep"), { recursive: true });
    for (const file of ["top.dashcut", "a/b/nested.dashcut", ".hidden/no.dashcut", "node_modules/no.dashcut", "x/y/z/deep/too-deep.dashcut", "a/notes.txt"]) await writeFile(path.join(root, file), doc(file));
    const found = (await findProjectFiles([root], { maxDepth: 3 })).map((file) => path.relative(root, file)).sort();
    assert.deepEqual(found, [path.join("a", "b", "nested.dashcut"), "top.dashcut"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("summarises a project with its saved preview, ratio and duration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dashcut-library-"));
  try {
    const file = path.join(root, "trip.dashcut");
    await writeFile(file, doc("Trip", { canvas: { ratio: "9:16", fps: 30 }, preview: "data:image/jpeg;base64,AAAA", clips: [{ id: "c", assetId: "x", trackId: "main", start: 2, in: 0, out: 6, speed: 2 }] }));
    const summary = await summarizeProject(file);
    assert.equal(summary.title, "Trip");
    assert.equal(summary.ratio, "9:16");
    assert.equal(summary.duration, 5);
    assert.equal(summary.preview, "data:image/jpeg;base64,AAAA");
    await writeFile(path.join(root, "other.dashcut"), JSON.stringify({ app: "Other" }));
    await assert.rejects(summarizeProject(path.join(root, "other.dashcut")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("falls back to the first visual clip on the main track for the preview", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dashcut-library-"));
  try {
    const picture = path.join(root, "still.png");
    await writeFile(picture, "png");
    const source = firstFrameSource({
      tracks: [{ id: "main", main: true }, { id: "v2", main: false }],
      assets: [{ id: "img", kind: "image", absolutePath: picture }, { id: "song", kind: "audio", absolutePath: picture }],
      clips: [{ assetId: "song", trackId: "main", start: 0 }, { assetId: "img", trackId: "v2", start: 0 }, { assetId: "img", trackId: "main", start: 3, in: 0 }],
    });
    assert.deepEqual(source, { file: picture, kind: "image", time: 0 });
    const file = path.join(root, "still.dashcut");
    await writeFile(file, doc("Still", { assets: [{ id: "img", kind: "image", path: "still.png", absolutePath: "/moved/still.png" }], clips: [{ assetId: "img", trackId: "main", start: 0, in: 0, out: 3, speed: 1 }] }));
    const summary = await summarizeProject(file, { cacheDir: path.join(root, "cache"), encodeImage: async (input) => `encoded:${path.basename(input)}` });
    assert.equal(summary.preview, "encoded:still.png");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lists recent projects first and leaves them out of the found list", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dashcut-library-"));
  try {
    const [recentFile, otherFile] = [path.join(root, "recent.dashcut"), path.join(root, "other.dashcut")];
    await writeFile(recentFile, doc("Recent"));
    await writeFile(otherFile, doc("Other"));
    const library = await projectLibrary({
      recent: [{ path: recentFile, title: "Recent", openedAt: "2026-02-01T00:00:00.000Z", exists: true }, { path: path.join(root, "gone.dashcut"), title: "Gone", openedAt: "", exists: false }],
      roots: [root],
    });
    assert.deepEqual(library.recent.map((item) => [item.title, Boolean(item.missing)]), [["Recent", false], ["Gone", true]]);
    assert.equal(library.recent[0].openedAt, "2026-02-01T00:00:00.000Z");
    assert.deepEqual(library.found.map((item) => item.title), ["Other"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
