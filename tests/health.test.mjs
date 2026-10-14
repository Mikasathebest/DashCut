import assert from "node:assert/strict";
import test from "node:test";
import { analysisIssues, captionIssues } from "../app/editor/health.ts";
import { defaultSubtitleStyle } from "../app/editor/captions.ts";

const canvas = { width: 1920, height: 1080 };
// Rough metric: CJK glyphs are one em wide, Latin about half an em.
const measure = (text, px) => [...text].reduce((sum, char) => sum + (/[㐀-鿿]/u.test(char) ? px : px * 0.55), 0);

test("caption checks flag overflow, fast reading, flashes and overlaps", () => {
  const subtitles = [
    { id: 1, start: 0, end: 2, zh: "正常的一句字幕", en: "A normal line" },
    { id: 2, start: 2.5, end: 3.0, zh: "这一句话非常非常长而且只显示半秒钟观众根本来不及读完", en: "" },
    { id: 3, start: 4, end: 4.4, zh: "嗨", en: "" },
    { id: 4, start: 5, end: 7, zh: "第一句", en: "" },
    { id: 5, start: 6, end: 8, zh: "第二句", en: "" },
    { id: 6, start: 9, end: 11, zh: "很".repeat(70), en: "" },
  ];
  const ids = captionIssues(subtitles, { ...defaultSubtitleStyle, fontSize: 48 }, "zh", canvas, measure).map((issue) => issue.id);
  assert.ok(!ids.some((id) => id.endsWith("-1")), ids.join(","));
  assert.ok(ids.includes("fast-2"));
  assert.ok(ids.includes("short-3"));
  assert.ok(ids.includes("overlap-4"));
  assert.ok(ids.includes("wide-6-zh"));
});

test("analysis checks report loudness, peaks, black frames and long silences", () => {
  const analysis = { duration: 30, integratedLufs: -24.2, loudnessRange: 6, truePeak: -0.3, blackFrames: [{ start: 10, end: 12 }], silences: [{ start: 20, end: 21 }, { start: 25, end: 29 }] };
  const unfixed = analysisIssues(analysis, null);
  assert.deepEqual(unfixed.map((issue) => issue.id), ["loudness", "peak", "black-10", "silence-25"]);
  assert.equal(unfixed.find((issue) => issue.id === "black-10").severity, "error");
  const normalised = analysisIssues(analysis, -14);
  assert.deepEqual(normalised.map((issue) => issue.id), ["loudness-ok", "black-10", "silence-25"]);
  assert.equal(analysisIssues({ ...analysis, integratedLufs: null, truePeak: null }, -14)[0].id, "silent");
});
