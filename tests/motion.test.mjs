import assert from "node:assert/strict";
import test from "node:test";
import { clipDuration, createClip, createProject, evaluateVisual, evaluateVolume, mainTrack, placeClip, renderClips, sourceRangeToTimeline, sourceTimeAt, splitClip, textBaseScale, toComposition, trackClips } from "../app/editor/model.ts";
import { curveIntegral, evaluateKeyframes, meanSpeed, outputFractionForSource, removeKeyframe, setKeyframe, sliceCurve, speedCurvePresets } from "../app/editor/motion.ts";

const near = (actual, expected, epsilon = 1e-6) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≈ ${expected}`);
const on = { magnet: true, linkage: true };
const asset = (id, kind = "video", duration = 10) => ({ id, name: id, kind, url: "", sourcePath: `/m/${id}`, duration, width: 1920, height: 1080, hasAudio: kind === "video", thumbnail: "", frames: [], peaks: [], peaksPerSecond: 0 });
const settings = { ratio: "16:9", resolution: 720, fps: 30, platform: "youtube", subtitleStyle: {}, subtitleMode: "both" };

test("keyframes interpolate with easing and hold outside their range", () => {
  const points = [{ time: 0, value: 0, easing: "linear" }, { time: 1, value: 10, easing: "ease-in" }, { time: 2, value: 20, easing: "hold" }, { time: 3, value: 0, easing: "linear" }];
  near(evaluateKeyframes(points, -1, 5), 0);
  near(evaluateKeyframes(points, 0.5, 5), 5);
  near(evaluateKeyframes(points, 1.5, 5), 12.5); // ease-in p² = .25
  near(evaluateKeyframes(points, 2.9, 5), 20); // hold
  near(evaluateKeyframes(points, 9, 5), 0);
  near(evaluateKeyframes(undefined, 1, 5), 5);
  const added = setKeyframe(points, 1.5, 99);
  assert.equal(added.length, 5);
  assert.equal(setKeyframe(added, 1.5, 7).find((point) => point.time === 1.5).value, 7);
  assert.equal(removeKeyframe([{ time: 1, value: 1, easing: "linear" }], 1), undefined);
});

test("speed curves integrate exactly and invert", () => {
  const ramp = [{ x: 0, y: 0.5 }, { x: 1, y: 2.5 }];
  near(meanSpeed(ramp), 1.5);
  near(curveIntegral(ramp, 0.5), 0.5 * (0.5 + 1.5) / 2);
  near(outputFractionForSource(ramp, curveIntegral(ramp, 0.3) / 1.5), 0.3, 1e-6);
  const sliced = sliceCurve(ramp, 0.5, 1);
  near(sliced[0].y, 1.5);
  near(sliced.at(-1).x, 1);
  for (const preset of speedCurvePresets) assert.ok(meanSpeed(preset.points) > 0.2, preset.id);
});

test("a speed-curved clip times, maps and splits consistently", () => {
  let project = createProject();
  const main = mainTrack(project).id;
  project = placeClip(project, createClip(asset("v", "video", 6), main, 0), main, 0, on);
  const id = project.clips[0].id;
  project = { ...project, clips: project.clips.map((clip) => ({ ...clip, speedCurve: [{ x: 0, y: 0.5 }, { x: 1, y: 2.5 }] })) };
  const clip = project.clips[0];
  near(clipDuration(clip), 4); // 6 s of source at mean 1.5×
  near(sourceTimeAt(clip, 4), 6);
  near(sourceTimeAt(clip, 2), 6 * curveIntegral(clip.speedCurve, 0.5) / 1.5);
  const mapped = sourceRangeToTimeline(clip, 0, sourceTimeAt(clip, 2));
  near(mapped.end, 2, 1e-5);
  const { project: split, rightId } = splitClip(project, id, 2);
  const left = split.clips.find((item) => item.id === id);
  const right = split.clips.find((item) => item.id === rightId);
  near(clipDuration(left) + clipDuration(right), 4, 1e-6);
  near(right.in, sourceTimeAt(clip, 2), 1e-9);
  // Export splits the curve into constant-speed pieces covering the whole source.
  const request = toComposition(project, [asset("v", "video", 6)], settings);
  assert.equal(request.visuals.length, 24);
  near(request.visuals[0].in, 0);
  near(request.visuals.at(-1).out, 6, 1e-9);
  assert.ok(request.visuals[0].speed < request.visuals.at(-1).speed);
  near(request.visuals.reduce((sum, item) => sum + (item.out - item.in) / item.speed, 0), 4, 1e-6);
});

test("clip keyframes drive transform and volume and survive a split", () => {
  let project = createProject();
  const main = mainTrack(project).id;
  project = placeClip(project, createClip(asset("v"), main, 0), main, 0, on);
  const id = project.clips[0].id;
  project = { ...project, clips: project.clips.map((clip) => ({ ...clip, keyframes: { x: [{ time: 0, value: -0.5, easing: "linear" }, { time: 4, value: 0.5, easing: "linear" }] }, audio: { ...clip.audio, volumeKeyframes: [{ time: 0, value: 0, easing: "linear" }, { time: 2, value: 2, easing: "linear" }] } })) };
  near(evaluateVisual(project.clips[0], 2).x, 0);
  near(evaluateVolume(project.clips[0], 1), 1);
  const { project: split, rightId } = splitClip(project, id, 3);
  const right = split.clips.find((clip) => clip.id === rightId);
  near(evaluateVisual(right, 3.5).x, 0.375);
  near(evaluateVolume(right, 3.5), 2);
});

test("transitions overlap neighbours using spare source, or dip to black without it", () => {
  let project = createProject();
  const main = mainTrack(project).id;
  const a = { ...createClip(asset("a", "video", 10), main, 0), in: 1, out: 5 };
  const b = { ...createClip(asset("b", "video", 10), main, 4), in: 2, out: 6 };
  project = { ...project, clips: [{ ...a, transitionOut: { type: "crossfade", duration: 1 } }, b] };
  const assets = new Map([["a", asset("a", "video", 10)], ["b", asset("b", "video", 10)]]);
  const [ra, rb] = renderClips(project, assets);
  near(ra.out, 5.5);
  near(rb.start, 3.5);
  near(rb.in, 1.5);
  assert.equal(rb.animationIn.type, "fade");
  near(rb.animationIn.duration, 1);
  near(ra.audio.fadeOut, 1);
  // B has no spare source before its in-point: dip to black instead, timeline untouched.
  const tight = { ...project, clips: [{ ...a, transitionOut: { type: "wipe", duration: 1 } }, { ...b, in: 0, out: 4 }] };
  const [da, db] = renderClips(tight, assets);
  assert.equal(da.animationOut.type, "fade");
  assert.equal(db.animationIn.type, "fade");
  near(db.start, 4);
  // Export draws the incoming clip above the outgoing one.
  const request = toComposition(project, [...assets.values()], settings);
  assert.deepEqual(request.visuals.map((visual) => visual.path), ["/m/a", "/m/b"]);
  near(request.duration, 8);
  assert.equal(trackClips(project, main).length, 2);
});

test("text layers keep their designed size whatever the canvas", () => {
  // A 540×108 box (font px at 1080p) is half the width of a 16:9 canvas.
  near(1 / textBaseScale(540, 108, "16:9"), 1920 / 540);
  let project = createProject();
  const track = project.tracks[0].id;
  const title = { ...asset("t", "text", 3), hasAudio: false };
  project = { ...project, clips: [{ ...createClip(title, track, 0), text: { content: "标题" } }] };
  const request = toComposition(project, [title], settings, new Map([[project.clips[0].id, { path: "/tmp/t.rgba", width: 360, height: 72, boxWidth: 540, boxHeight: 108 }]]));
  assert.equal(request.visuals[0].kind, "rgba");
  assert.deepEqual(request.visuals[0].rgba, { width: 360, height: 72 });
  near(request.visuals[0].transform.scale, textBaseScale(540, 108, "16:9"));
});

test("adding a speed curve re-packs the magnetic main track", async () => {
  const { updateClip } = await import("../app/editor/model.ts");
  let project = createProject();
  const main = mainTrack(project).id;
  project = placeClip(project, createClip(asset("a", "video", 6), main, 0), main, 0, on);
  project = placeClip(project, createClip(asset("b", "image", 3), main, 99), main, 99, on);
  const [a, b] = trackClips(project, main);
  const curved = updateClip(project, a.id, { speedCurve: [{ x: 0, y: 0.5 }, { x: 1, y: 2.5 }] }, on);
  near(curved.clips.find((clip) => clip.id === b.id).start, 4);
});
