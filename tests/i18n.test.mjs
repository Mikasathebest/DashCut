import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { getLanguage, setLanguage, t } from "../app/i18n/index.ts";
import editing from "../app/i18n/en/editing.ts";
import workspace from "../app/i18n/en/workspace.ts";
import panels from "../app/i18n/en/panels.ts";

const root = new URL("..", import.meta.url).pathname;

test("t() falls back to the Chinese source and fills placeholders", () => {
  setLanguage("zh");
  assert.equal(t("已导入 {count} 个素材", { count: 3 }), "已导入 3 个素材");
  setLanguage("en");
  assert.equal(t("一段没有翻译的文字"), "一段没有翻译的文字");
  assert.equal(t("{a} 和 {b}", { a: 1 }), "1 和 {b}");
  setLanguage("zh");
  assert.equal(getLanguage(), "zh");
});

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "i18n" ? [] : sourceFiles(full);
    return /\.(tsx?|mjs)$/.test(entry.name) ? [full] : [];
  }));
  return files.flat();
}

test("every t() key used in the app has an English translation", async () => {
  const dictionary = { ...workspace, ...editing, ...panels };
  const missing = [];
  for (const file of await sourceFiles(path.join(root, "app"))) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) {
      const key = JSON.parse(`"${match[1]}"`);
      if (/[㐀-鿿]/u.test(key) && !(key in dictionary)) missing.push(`${path.relative(root, file)}: ${key}`);
    }
  }
  assert.deepEqual(missing, [], `Missing English for:\n${missing.join("\n")}`);
});

test("dictionaries translate to non-empty English and keep placeholders", () => {
  for (const [key, value] of Object.entries({ ...workspace, ...editing, ...panels })) {
    assert.ok(value.trim(), `empty translation for ${key}`);
    const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(",");
    assert.equal(placeholders(value), placeholders(key), `placeholders differ for ${key}`);
  }
});
