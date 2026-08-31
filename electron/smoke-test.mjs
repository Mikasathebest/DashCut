import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startAppServer } from "./server.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = await startAppServer({ rootDir });
try {
  const response = await fetch(desktop.url);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /DashCut/);
  assert.match(html, /自动字幕/);
  const asset = await fetch(`${desktop.url}/og.png`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type") ?? "", /^image\/png/);
  console.log(`Desktop smoke test passed at ${desktop.url}`);
} finally {
  await desktop.close();
}
