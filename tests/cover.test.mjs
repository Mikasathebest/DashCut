import assert from "node:assert/strict";
import test from "node:test";
import { applyCollage, backgroundImage, collageCells, emptyCover, newImage, newText, normalizeCover, setBackground } from "../app/editor/cover.ts";

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ""} ${actual} ≠ ${expected}`);

test("collage cells tile the canvas with equal gutters", () => {
  const row = collageCells("row", 3, 0.01, 16 / 9);
  assert.equal(row.length, 3);
  near(row[0].x, 0.01);
  near(row[2].x + row[2].w, 0.99);
  near(row[1].x - (row[0].x + row[0].w), 0.01, "gap between cells");
  near(row[0].y, 0.01 * 16 / 9, "vertical gutter is the same number of pixels");
  const grid = collageCells("grid", 4, 0, 1);
  assert.deepEqual(grid.map((cell) => [cell.x, cell.y]), [[0, 0], [0.5, 0], [0, 0.5], [0.5, 0.5]]);
  const feature = collageCells("feature", 3, 0, 1);
  near(feature[0].w, 2 / 3);
  near(feature[1].h + feature[2].h, 1);
});

test("collage arranges pictures but leaves the background and text alone", () => {
  const background = backgroundImage("bg", 16 / 9);
  const pictures = [newImage("a", 1, 16 / 9), newImage("b", 2, 16 / 9)];
  const title = newText("标题");
  const design = applyCollage({ ...emptyCover(), layers: [background, ...pictures, title] }, "column", 0, 16 / 9);
  assert.deepEqual(design.layers[0], background);
  assert.deepEqual(design.layers[3], title);
  assert.deepEqual(design.layers.slice(1, 3).map((layer) => [layer.y, layer.h]), [[0, 0.5], [0.5, 0.5]]);
});

test("a new background replaces the old one and sits at the bottom", () => {
  const picture = newImage("a", 1, 1);
  const first = setBackground({ ...emptyCover(), layers: [picture] }, backgroundImage("one", 1));
  const second = setBackground(first, backgroundImage("two", 1, 3));
  assert.deepEqual(second.layers.map((layer) => layer.src), ["two", "a"]);
  assert.equal(second.layers[0].frameTime, 3);
});

test("old title/accent covers load as an empty design with no preset text", () => {
  assert.deepEqual(normalizeCover({ title: "独自旅行的 48 小时", accent: "#ffcc45" }), emptyCover());
  const restored = normalizeCover({ background: "#123456", layers: [{ id: "x", kind: "text", text: "hi" }, { kind: "image" }, null] });
  assert.equal(restored.background, "#123456");
  assert.equal(restored.layers.length, 1);
  assert.equal(restored.layers[0].id, "x");
  assert.equal(restored.layers[0].color, "#ffffff");
});
