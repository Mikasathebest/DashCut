import assert from "node:assert/strict";
import test from "node:test";
import {
  addTrack, clipDuration, clipEnd, createClip, createProject, deleteClips, evaluateVisual, freezeFrame, mainTrack, placeClip,
  replaceWithRanges, sourceRangeToTimeline, sourceTimeAt, splitAtSourceTimes, splitClip, toComposition, trackClips, trimAt, updateClip,
} from "../app/editor/model.ts";

const on = { magnet: true, linkage: true };
const asset = (id, kind = "video", duration = 10) => ({ id, name: `${id}.mp4`, kind, url: "", sourcePath: `/media/${id}`, duration, width: 1920, height: 1080, hasAudio: kind !== "image", thumbnail: "", frames: [], peaks: [], peaksPerSecond: 0 });

function withMain(...assets) {
  let project = createProject();
  const main = mainTrack(project).id;
  for (const item of assets) project = placeClip(project, createClip(item, main, 9999), main, 9999, on);
  return project;
}

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} ≈ ${expected}`);

test("main track packs clips in order without gaps", () => {
  const project = withMain(asset("a", "video", 4), asset("b", "image", 3));
  const clips = trackClips(project, mainTrack(project).id);
  assert.deepEqual(clips.map((clip) => [clip.assetId, clip.start]), [["a", 0], ["b", 4]]);
});

test("inserting onto the main track ripples overlays when linkage is on", () => {
  let project = withMain(asset("a", "video", 4), asset("b", "video", 4));
  const overlayTrack = addTrack(project, "video", "top");
  project = placeClip(overlayTrack.project, createClip(asset("pip", "image", 2), overlayTrack.trackId, 5), overlayTrack.trackId, 5, on);
  project = placeClip(project, createClip(asset("c", "video", 2), mainTrack(project).id, 3.9), mainTrack(project).id, 1, on);
  const main = trackClips(project, mainTrack(project).id);
  assert.deepEqual(main.map((clip) => [clip.assetId, clip.start]), [["c", 0], ["a", 2], ["b", 6]]);
  near(project.clips.find((clip) => clip.assetId === "pip").start, 7);
});

test("split keeps source continuity, including reversed clips", () => {
  const project = withMain(asset("a", "video", 10));
  const id = project.clips[0].id;
  const { project: split, rightId } = splitClip(project, id, 4);
  const left = split.clips.find((clip) => clip.id === id);
  const right = split.clips.find((clip) => clip.id === rightId);
  assert.deepEqual([left.in, left.out, right.in, right.out, right.start], [0, 4, 4, 10, 4]);
  const reversed = updateClip(project, id, { reverse: true, speed: 2 }, on);
  const result = splitClip(reversed, id, 2);
  const rLeft = result.project.clips.find((clip) => clip.id === id);
  const rRight = result.project.clips.find((clip) => clip.id === result.rightId);
  // Reversed at 2×: the first 2 timeline seconds show source 10 → 6.
  assert.deepEqual([rLeft.in, rLeft.out, rRight.in, rRight.out], [6, 10, 0, 6]);
  near(sourceTimeAt(rRight, 2.5), 5);
});

test("trim left/right at the playhead and delete close the main-track gap and move subtitles", () => {
  let project = withMain(asset("a", "video", 6), asset("b", "video", 4));
  project = { ...project, subtitles: [{ id: 1, start: 7, end: 8, zh: "字幕", en: "" }] };
  const [a, b] = trackClips(project, mainTrack(project).id);
  const trimmed = trimAt(project, a.id, 2, "left", on);
  const first = trimmed.clips.find((clip) => clip.id === a.id);
  assert.deepEqual([first.start, first.in, first.out], [0, 2, 6]);
  near(trimmed.clips.find((clip) => clip.id === b.id).start, 4);
  near(trimmed.subtitles[0].start, 5);
  const cut = trimAt(project, a.id, 5, "right", on);
  near(clipEnd(cut.clips.find((clip) => clip.id === a.id)), 5);
  const deleted = deleteClips(project, [a.id], on);
  assert.equal(deleted.clips.find((clip) => clip.id === b.id).start, 0);
  near(deleted.subtitles[0].start, 1);
});

test("speed changes duration and settles the main track", () => {
  let project = withMain(asset("a", "video", 6), asset("b", "video", 4));
  const [a, b] = trackClips(project, mainTrack(project).id);
  project = updateClip(project, a.id, { speed: 2 }, on);
  near(clipDuration(project.clips.find((clip) => clip.id === a.id)), 3);
  near(project.clips.find((clip) => clip.id === b.id).start, 3);
});

test("freeze frame inserts a held frame and pushes later clips", () => {
  const project = withMain(asset("a", "video", 6), asset("b", "video", 4));
  const [a, b] = trackClips(project, mainTrack(project).id);
  const { project: frozen, freezeId } = freezeFrame(project, a.id, 2, 3, on);
  const freeze = frozen.clips.find((clip) => clip.id === freezeId);
  assert.equal(freeze.freezeAt, 2);
  assert.equal(freeze.start, 2);
  near(clipDuration(freeze), 3);
  near(frozen.clips.find((clip) => clip.id === b.id).start, 9);
  assert.equal(trackClips(frozen, mainTrack(frozen).id).length, 4);
});

test("smart cuts replace a clip with speech ranges and split at scene times", () => {
  const project = withMain(asset("a", "video", 10), asset("b", "video", 2));
  const [a, b] = trackClips(project, mainTrack(project).id);
  const talk = replaceWithRanges(project, a.id, [{ start: 0, end: 2 }, { start: 5, end: 7 }], on);
  const pieces = trackClips(talk, mainTrack(talk).id);
  assert.deepEqual(pieces.map((clip) => [clip.in, clip.out, clip.start]), [[0, 2, 0], [5, 7, 2], [0, 2, 4]]);
  assert.equal(pieces[2].id, b.id);
  const scenes = splitAtSourceTimes(project, a.id, [3, 7.5]);
  assert.deepEqual(trackClips(scenes, mainTrack(scenes).id).slice(0, 3).map((clip) => [clip.in, clip.out]), [[0, 3], [3, 7.5], [7.5, 10]]);
});

test("animations match the exporter contract", () => {
  const clip = { ...createClip(asset("a"), "track-main", 10), animationIn: { type: "slide-left", duration: 1 }, animationOut: { type: "zoom-out", duration: 2 } };
  near(evaluateVisual(clip, 10).x, -1);
  near(evaluateVisual(clip, 10.5).x, -0.5);
  near(evaluateVisual(clip, 11).x, 0);
  near(evaluateVisual(clip, 19).scale, 1.25);
  const fade = { ...clip, animationIn: { type: "fade", duration: 2 }, transform: { ...clip.transform, opacity: 0.8 } };
  near(evaluateVisual(fade, 11).opacity, 0.4);
});

test("captions map from source time onto each clip using that asset", () => {
  const clip = { ...createClip(asset("a"), "track-main", 4), in: 2, out: 8, speed: 2 };
  assert.deepEqual(sourceRangeToTimeline(clip, 1, 4), { start: 4, end: 5, sourceStart: 2, sourceEnd: 4 });
  assert.equal(sourceRangeToTimeline(clip, 8.5, 9), null);
  assert.equal(sourceRangeToTimeline({ ...clip, reverse: true }, 3, 4), null);
});

test("composition lists visual layers bottom to top and audio tracks separately", () => {
  let project = withMain(asset("a", "video", 4));
  const overlay = addTrack(project, "video", "top");
  project = placeClip(overlay.project, createClip(asset("pip", "image", 2), overlay.trackId, 1), overlay.trackId, 1, on);
  const audioTrack = project.tracks.find((track) => track.kind === "audio");
  project = placeClip(project, createClip(asset("song", "audio", 5), audioTrack.id, 0), audioTrack.id, 0, on);
  const assets = [asset("a", "video", 4), asset("pip", "image", 2), asset("song", "audio", 5)];
  const request = toComposition(project, assets, { ratio: "9:16", resolution: 1080, fps: 30, platform: "youtube", subtitleStyle: {}, subtitleMode: "both" });
  assert.deepEqual([request.width, request.height], [1080, 1920]);
  assert.deepEqual(request.visuals.map((visual) => visual.path), ["/media/a", "/media/pip"]);
  assert.deepEqual(request.audios.map((audio) => audio.path), ["/media/song"]);
  assert.equal(request.duration, 5);
  assert.equal(request.visuals[1].speed, 1);
});

test("linkage ripples only attachments after the edited part of the main clip", () => {
  let project = withMain(asset("a", "video", 6), asset("b", "video", 4));
  const overlay = addTrack(project, "video", "top");
  project = placeClip(overlay.project, createClip(asset("inside", "image", 1), overlay.trackId, 2), overlay.trackId, 2, on);
  project = placeClip(project, createClip(asset("after", "image", 1), overlay.trackId, 7), overlay.trackId, 7, on);
  const a = trackClips(project, mainTrack(project).id)[0];
  const faster = updateClip(project, a.id, { speed: 2 }, on);
  near(faster.clips.find((clip) => clip.assetId === "inside").start, 2);
  near(faster.clips.find((clip) => clip.assetId === "after").start, 4);
  // A left trim at 1s drags the overlay over the kept part along with it.
  const trimmed = trimAt(project, a.id, 1, "left", on);
  near(trimmed.clips.find((clip) => clip.assetId === "inside").start, 1);
  near(trimmed.clips.find((clip) => clip.assetId === "after").start, 6);
});
