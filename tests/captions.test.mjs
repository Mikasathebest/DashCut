import assert from "node:assert/strict";
import test from "node:test";
import { captionLines, normalizeSubtitleStyle, retimeSubtitle, shiftSubtitles } from "../app/editor/captions.ts";

const captions = [{ id: 1, start: 1, end: 2, zh: "一", en: "one" }, { id: 2, start: 3, end: 4, zh: "二", en: "two" }, { id: 3, start: 5, end: 6, zh: "三", en: "three" }];
const times = (list) => list.map(({ start, end }) => [start, end]);

test("shifts every caption or ripples from a selected caption", () => {
  assert.deepEqual(times(shiftSubtitles(captions, 1.5)), [[2.5, 3.5], [4.5, 5.5], [6.5, 7.5]]);
  assert.deepEqual(times(shiftSubtitles(captions, 1, 2)), [[1, 2], [4, 5], [6, 7]]);
});

test("backward shifts stop at zero or the previous caption", () => {
  assert.deepEqual(times(shiftSubtitles(captions, -5)), [[0, 1], [2, 3], [4, 5]]);
  assert.deepEqual(times(shiftSubtitles(captions, -5, 2)), [[1, 2], [2, 3], [4, 5]]);
});

test("retiming a start moves later captions; extending an end pushes only on overlap", () => {
  assert.deepEqual(times(retimeSubtitle(captions, 2, "start", 3.5)), [[1, 2], [3.5, 4.5], [5.5, 6.5]]);
  assert.deepEqual(times(retimeSubtitle(captions, 1, "end", 2.5)), [[1, 2.5], [3, 4], [5, 6]]);
  assert.deepEqual(times(retimeSubtitle(captions, 1, "end", 3.4)), [[1, 3.4], [3.4, 4.4], [5.4, 6.4]]);
});

test("caption lines follow mode and order; old styles gain new defaults", () => {
  const style = normalizeSubtitleStyle({ color: "#ff0000" });
  assert.equal(style.position, "bottom");
  assert.deepEqual(captionLines(captions[0], "both", style).map((line) => line.text), ["一", "one"]);
  assert.deepEqual(captionLines(captions[0], "both", { ...style, order: "en-first" }).map((line) => line.text), ["one", "一"]);
  assert.deepEqual(captionLines(captions[0], "en", style).map((line) => line.text), ["one"]);
  assert.deepEqual(captionLines({ zh: "", en: "x" }, "zh", style), []);
});
