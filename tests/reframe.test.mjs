import assert from "node:assert/strict";
import test from "node:test";
import { chooseSubject, computeReframe, coverScale } from "../app/editor/reframe.ts";
import { evaluateKeyframes } from "../app/editor/motion.ts";

const near = (actual, expected, epsilon = 1e-3) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≈ ${expected}`);
const landscapeInPortrait = { mediaAspect: 16 / 9, canvasAspect: 9 / 16 };

test("cover scale fills a portrait canvas with landscape footage", () => {
  near(coverScale(16 / 9, 9 / 16), (16 / 9) / (9 / 16));
  near(coverScale(1, 1), 1);
});

test("a subject held off-centre is framed in the middle, within the frame edges", () => {
  const samples = Array.from({ length: 21 }, (_, index) => ({ time: index * 0.25, center: 0.75 }));
  const { scale, keyframes } = computeReframe(samples, { ...landscapeInPortrait, tracking: 1 });
  const settled = evaluateKeyframes(keyframes, 5, 0);
  // Subject at 75% of the width → move the media left by a quarter of its box width.
  near(settled, -0.25 * scale, 0.02);
  // Never slide so far that the canvas edge shows background.
  const extreme = computeReframe(samples.map((sample) => ({ ...sample, center: 1 })), { ...landscapeInPortrait, tracking: 1 });
  assert.ok(Math.abs(evaluateKeyframes(extreme.keyframes, 5, 0)) <= (extreme.scale - 1) / 2 + 1e-6);
});

test("tracking speed limits how fast the framing pans, and steady shots keep few keyframes", () => {
  const jump = Array.from({ length: 41 }, (_, index) => ({ time: index * 0.25, center: index < 20 ? 0.3 : 0.7 }));
  const calm = computeReframe(jump, { ...landscapeInPortrait, tracking: 0 });
  const quick = computeReframe(jump, { ...landscapeInPortrait, tracking: 1 });
  const at = (result, time) => evaluateKeyframes(result.keyframes, time, 0);
  // Half a second after the subject moves, the quick setting has travelled much further.
  assert.ok(Math.abs(at(quick, 5.5) - at(quick, 4.75)) > Math.abs(at(calm, 5.5) - at(calm, 4.75)) * 2);
  const steady = computeReframe(Array.from({ length: 40 }, (_, index) => ({ time: index * 0.25, center: 0.5 })), { ...landscapeInPortrait, tracking: 0.5 });
  assert.equal(steady.keyframes.length, 2);
});

test("missing detections hold the last framing and the nearest face is followed", () => {
  const samples = [{ time: 0, center: 0.8 }, { time: 0.25, center: null }, { time: 0.5, center: null }];
  const { keyframes, detected } = computeReframe(samples, { ...landscapeInPortrait, tracking: 1 });
  assert.equal(detected, 1);
  near(evaluateKeyframes(keyframes, 0.5, 0), evaluateKeyframes(keyframes, 0, 0));
  assert.equal(chooseSubject([{ center: 0.2, size: 900 }, { center: 0.6, size: 100 }], 0.55), 0.6);
  assert.equal(chooseSubject([{ center: 0.2, size: 900 }, { center: 0.6, size: 100 }], null), 0.2);
  assert.equal(chooseSubject([], 0.5), null);
});
