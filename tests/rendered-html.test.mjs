import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { assessHardware } = require("../electron/hardware.cjs");
const { getModels, removeModel } = require("../electron/model-manager.cjs");

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the DashCut editor", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>DashCut 极剪 — 双语智能视频编辑器<\/title>/i);
  assert.match(html, /自动字幕/);
  assert.match(html, /中英双语/);
  assert.match(html, /导出视频/);
  assert.match(html, /分割/);
  assert.match(html, /城市漫游/);
  assert.match(html, /云端模型/);
  assert.match(html, /本地模型/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("ships product metadata and removes the starter preview", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(page, /DashCut/);
  assert.match(page, /关于与许可/);
  assert.match(page, /FFmpeg 9\.0\.1/);
  assert.match(page, /accept="video\/\*"/);
  assert.match(page, /exportFps/);
  assert.match(layout, /og\.png/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.doesNotReject(access(new URL("../public/og.png", import.meta.url)));
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});

test("grades faster-whisper hardware conservatively", () => {
  const base = {
    memory: { totalGb: 16, freeGb: 10 },
    cpu: { logicalCores: 8 },
    diskFreeGb: 20,
    gpus: [],
    python: { version: "3.12.1", supported: true, fasterWhisperInstalled: true, cudaRuntimeReady: false },
  };
  assert.equal(assessHardware(base).tier, "minimum");
  assert.equal(assessHardware({
    ...base,
    gpus: [{ name: "RTX", memoryGb: 8, fasterWhisperAcceleration: true }],
    python: { ...base.python, cudaRuntimeReady: true },
  }).tier, "recommended");
  assert.equal(assessHardware({ ...base, memory: { totalGb: 4, freeGb: 2 } }).tier, "unsupported");
});

test("marks local models installed only after required files exist", async () => {
  const modelsPath = await mkdtemp(path.join(tmpdir(), "dashcut-models-"));
  const options = { modelsPath };
  try {
    assert.equal((await getModels(options)).find((model) => model.id === "small").installed, false);
    const smallPath = path.join(modelsPath, "small");
    await mkdir(smallPath);
    await Promise.all(["config.json", "model.bin", "tokenizer.json"].map((name) => writeFile(path.join(smallPath, name), "test")));
    assert.equal((await getModels(options)).find((model) => model.id === "small").installed, true);
    await removeModel("small", options);
    assert.equal((await getModels(options)).find((model) => model.id === "small").installed, false);
  } finally {
    await rm(modelsPath, { recursive: true, force: true });
  }
});
