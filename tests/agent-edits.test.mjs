import assert from "node:assert/strict";
import test from "node:test";
import { addTrack, createClip, createProject, mainTrack, placeClip, trackClips } from "../app/editor/model.ts";
import { applyAgentEdits, cleanCutCandidates, findSegments, getTranscript, serializeTimeline } from "../app/editor/agent.ts";

const options = { magnet: true, linkage: true };
const style = { fontFamily: "Arial", fontSize: 34, color: "#ffffff", outlineWidth: 2, backgroundOpacity: 35 };
const asset = (id, kind, duration, extra = {}) => ({ id, name: `${id}.${kind === "audio" ? "m4a" : kind === "image" ? "jpg" : "mp4"}`, kind, url: "", sourcePath: `/m/${id}`, duration, width: kind === "audio" ? 0 : 1920, height: kind === "audio" ? 0 : 1080, hasAudio: kind !== "image", thumbnail: "data:x", frames: ["data:y"], peaks: [0.4], peaksPerSecond: 50, ...extra });

function context(revision = 7) {
  const assets = [asset("talk", "video", 20), asset("logo", "image", 3), asset("song", "audio", 30)];
  let project = createProject();
  const main = mainTrack(project).id;
  project = placeClip(project, createClip(assets[0], main, 0), main, 0, options);
  const overlay = addTrack(project, "video", "top");
  project = placeClip(overlay.project, { ...createClip(assets[1], overlay.trackId, 2), transform: { x: 0.3, y: -0.3, scale: 0.25, rotation: 0, opacity: 1 } }, overlay.trackId, 2, options);
  const words = [
    { start: 0, end: 0.5, text: "大家好", prob: 0.9 }, { start: 0.6, end: 0.8, text: "嗯", prob: 0.9 }, { start: 1.0, end: 1.6, text: "今天聊聊", prob: 0.9 },
    { start: 5.0, end: 5.6, text: "剪辑技巧", prob: 0.9 }, { start: 6.0, end: 6.5, text: "点赞", prob: 0.9 },
  ];
  project = { ...project, transcripts: { talk: { language: "zh", source: "local", words, sentences: [{ start: 0, end: 1.6 }, { start: 5.0, end: 6.5 }] } }, subtitles: [{ id: 1, start: 0, end: 1.6, zh: "大家好今天聊聊", en: "Hi, today" }], markers: [{ id: "m", time: 4 }] };
  return { project, assets, revision, title: "演示", ratio: "16:9", captionStyle: style, captionMode: "both", options };
}

test("timeline view is compact, deterministic and hides internal ids", () => {
  const view = serializeTimeline(context());
  assert.equal(view, serializeTimeline(context()));
  assert.equal(view, [
    "# DashCut timeline revision=7",
    "title: 演示",
    "canvas: 16:9 duration=20000ms (all times in ms)",
    "assets:",
    '  A1 video "talk.mp4" duration=20000 size=1920x1080 audio=yes transcript=zh',
    '  A2 image "logo.jpg" duration=3000 size=1920x1080 audio=no',
    '  A3 audio "song.m4a" duration=30000 audio=yes unused',
    "tracks (top to bottom; upper video tracks draw over lower ones):",
    "  T1 video overlay",
    "    C1 A2 start=2000 end=5000 src=0-3000 transform=x:0.3,y:-0.3,scale:0.25",
    "  T2 video main",
    "    C2 A1 start=0 end=20000 src=0-20000",
    "  T3 audio",
    "captions: 1 lines, view=both",
    '  #1 0-1600 zh="大家好今天聊聊" en="Hi, today"',
    "markers: 4000",
  ].join("\n"));
  assert.doesNotMatch(view, /clip-|asset-|track-|data:/);
});

test("read helpers expose transcript sentences, search and clean-cut candidates in ms", () => {
  const ctx = context();
  assert.deepEqual(getTranscript(ctx).map((item) => [item.clip, item.start, item.text]), [["C2", 0, "大家好嗯今天聊聊"], ["C2", 5000, "剪辑技巧点赞"]]);
  assert.deepEqual(findSegments(ctx, "剪辑").map((item) => item.start), [5000]);
  const candidates = cleanCutCandidates(ctx);
  assert.ok(candidates.some((item) => item.kind === "filler" && item.label === "嗯" && item.sourceStart === 600));
  assert.ok(candidates.some((item) => item.kind === "pause" && item.clip === "C2"));
});

test("stale revisions are rejected without touching the project", () => {
  const ctx = context(9);
  const result = applyAgentEdits(ctx, { baseRevision: 8, ops: [{ op: "delete", clip: "C1" }] });
  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /revision 9/);
});

test("a batch is all-or-nothing and reports every bad op with its index", () => {
  const ctx = context();
  const result = applyAgentEdits(ctx, { baseRevision: 7, ops: [
    { op: "speed", clip: "C2", speed: 2 },
    { op: "speed", clip: "C9", speed: 2 },
    { op: "transform", clip: "C1", scale: 99 },
    { op: "effect", clip: "C3", effect: "bw" },
    { op: "explode" },
  ] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map((issue) => issue.index), [1, 2, 3, 4]);
  assert.match(result.issues[0].message, /找不到片段 C9/);
  assert.match(result.issues[1].message, /scale=99 超出范围/);
  assert.match(result.issues[3].message, /未知操作/);
});

test("valid ops apply in order on a staged copy", () => {
  const ctx = context();
  const result = applyAgentEdits(ctx, { baseRevision: 7, ops: [
    { op: "cutSource", clip: "C2", start: 600, end: 800 },
    { op: "fit", clip: "C2", mode: "cover", ratio: "9:16" },
    { op: "canvas", ratio: "9:16" },
    { op: "insert", asset: "A3", track: "audio", start: 0 },
    { op: "addCaption", start: 5000, end: 6000, zh: "剪辑技巧", en: "Editing tips" },
    { op: "captionStyle", style: { fontSize: 48, color: "#ffcc00" } },
    { op: "captionView", mode: "zh" },
    { op: "effect", clip: "C1", effect: "vignette" },
  ] });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  const main = trackClips(result.project, mainTrack(result.project).id);
  assert.equal(main.length, 2, "the cut splits the talking-head clip");
  assert.ok(Math.abs(main[0].transform.scale - 3.1605) < 0.001, "cover scale for 16:9 media in a 9:16 canvas (C2 keeps the left piece)");
  assert.equal(result.ratio, "9:16");
  assert.equal(result.captionMode, "zh");
  assert.deepEqual([result.captionStyle.fontSize, result.captionStyle.color, result.captionStyle.fontFamily], [48, "#ffcc00", "Arial"]);
  assert.equal(result.project.subtitles.length, 2);
  assert.ok(result.project.clips.some((clip) => clip.assetId === "song"));
  assert.equal(result.changes.length, 8);
  // The base context is untouched (the caller commits the result as one undo step).
  assert.equal(trackClips(ctx.project, mainTrack(ctx.project).id).length, 1);
});

test("clips removed earlier in a batch cannot be edited later in it", () => {
  const result = applyAgentEdits(context(), { baseRevision: 7, ops: [{ op: "delete", clip: "C1" }, { op: "speed", clip: "C1", speed: 2 }] });
  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /已在本批次中被删除/);
});

test("assembleMain rebuilds the main track from source ranges for highlights", () => {
  const result = applyAgentEdits(context(), { baseRevision: 7, ops: [{ op: "assembleMain", segments: [{ asset: "A1", in: 5000, out: 6500 }, { asset: "A1", in: 0, out: 500 }] }] });
  assert.equal(result.ok, true);
  const main = trackClips(result.project, mainTrack(result.project).id);
  assert.deepEqual(main.map((clip) => [clip.start, clip.in, clip.out]), [[0, 5, 6.5], [1.5, 0, 0.5]]);
});
