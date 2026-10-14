import assert from "node:assert/strict";
import test from "node:test";
import { createClip, createProject, cutSourceRanges, mainTrack, placeClip, trackClips } from "../app/editor/model.ts";
import { analyzeCleanCut, defaultCleanCutSettings, similarity, timelineTranscript, wordsToCuts } from "../app/editor/transcript.ts";

const on = { magnet: true, linkage: true };
const near = (actual, expected, epsilon = 1e-6) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≈ ${expected}`);
const asset = (id, duration) => ({ id, name: id, kind: "video", url: "", sourcePath: `/m/${id}`, duration, width: 1920, height: 1080, hasAudio: true, thumbnail: "", frames: [], peaks: [], peaksPerSecond: 0 });
const w = (start, end, text, prob = 0.9) => ({ start, end, text, prob });

// "大家好 嗯 今天 我们 我们 聊聊 [long pause] 剪辑 那个 技巧" plus an abandoned first take.
const words = [
  w(0.0, 0.4, "大家"), w(0.4, 0.7, "好"), w(0.9, 1.1, "嗯"), w(1.2, 1.6, "今天"), w(1.6, 1.9, "我们"), w(1.9, 2.2, "我们"), w(2.2, 2.6, "聊聊"),
  w(4.0, 4.4, "剪辑"), w(4.4, 4.7, "那个"), w(4.7, 5.1, "技巧"),
  w(6.0, 6.3, "这期"), w(6.3, 6.6, "视频"), w(7.0, 7.3, "这期"), w(7.3, 7.6, "视频"), w(7.6, 8.0, "很"), w(8.0, 8.3, "重要"),
];
const sentences = [{ start: 0, end: 2.6 }, { start: 4.0, end: 5.1 }, { start: 6.0, end: 6.8 }, { start: 7.0, end: 8.3 }];

function talkingHead() {
  let project = createProject();
  const main = mainTrack(project).id;
  project = placeClip(project, createClip(asset("talk", 9), main, 0), main, 0, on);
  project = placeClip(project, createClip(asset("outro", 3), main, 99), main, 99, on);
  return { ...project, transcripts: { talk: { language: "zh", source: "local", words, sentences } }, subtitles: [
    { id: 1, start: 0, end: 2.6, zh: "大家好嗯今天我们我们聊聊", en: "", words: words.slice(0, 7) },
    { id: 2, start: 4.0, end: 5.1, zh: "剪辑那个技巧", en: "", words: words.slice(7, 10) },
  ] };
}

test("timeline transcript follows clip trims and speed", () => {
  let project = talkingHead();
  const clip = trackClips(project, mainTrack(project).id)[0];
  project = { ...project, clips: project.clips.map((item) => item.id === clip.id ? { ...item, in: 1.2, speed: 2 } : item) };
  const [block] = timelineTranscript(project);
  assert.equal(block.words[0].text, "今天");
  near(block.words[0].start, 0);
  near(block.words[1].start, 0.2);
});

test("clean cut finds fillers, stutters, long pauses and an abandoned take", () => {
  const items = analyzeCleanCut(talkingHead(), defaultCleanCutSettings);
  const summary = items.map((item) => `${item.kind}:${item.label}:${item.accepted}`);
  assert.ok(summary.includes("filler:嗯:true"), summary.join(" | "));
  assert.ok(summary.includes("filler:那个:false"), "weak fillers are flagged but kept");
  assert.ok(summary.some((value) => value.startsWith("stutter:我们…我们")));
  const pause = items.find((item) => item.kind === "pause" && item.sourceStart > 2.5 && item.sourceStart < 3);
  near(pause.sourceStart, 2.75);
  near(pause.sourceEnd, 3.85);
  const retake = items.find((item) => item.kind === "retake");
  near(retake.sourceStart, 6.0);
  near(retake.sourceEnd, 7.0);
  assert.ok(similarity("这期视频", "这期视频很重要") > 0.6);
});

test("cutting accepted items ripples media, captions and the next clip in one project", () => {
  const project = talkingHead();
  const items = analyzeCleanCut(project, defaultCleanCutSettings).filter((item) => item.accepted);
  const cut = cutSourceRanges(project, items.map((item) => ({ clipId: item.clipId, start: item.sourceStart, end: item.sourceEnd })), on);
  const main = trackClips(cut, mainTrack(cut).id);
  const removed = items.reduce((sum, item) => sum + item.sourceEnd - item.sourceStart, 0);
  const total = main.reduce((sum, clip) => sum + (clip.out - clip.in) / clip.speed, 0);
  near(total, 12 - removed, 0.05);
  // Contiguous after packing, with the outro still last.
  main.slice(1).forEach((clip, index) => near(clip.start, main[index].start + (main[index].out - main[index].in), 1e-6));
  assert.equal(main.at(-1).assetId, "outro");
  // The "嗯" left caption 1; caption 2 moved up by the pause that was removed before it.
  assert.ok(!cut.subtitles[0].words.some((word) => word.text === "嗯"));
  assert.ok(cut.subtitles[1].start < 4.0 - 1);
  // Remaining words stay in order on the new timeline.
  const text = timelineTranscript(cut).flatMap((block) => block.words.map((word) => word.text)).join("");
  assert.equal(text, "大家好今天我们聊聊剪辑那个技巧这期视频很重要");
});

test("deleting selected transcript words is a ripple cut with captions trimmed", () => {
  const project = talkingHead();
  const selected = timelineTranscript(project)[0].words.filter((word) => ["今天", "我们"].includes(word.text) && word.start < 1.9);
  const cuts = wordsToCuts(selected);
  assert.equal(cuts.length, 1);
  const cut = cutSourceRanges(project, cuts, on);
  const text = timelineTranscript(cut).flatMap((block) => block.words.map((word) => word.text)).join("");
  assert.ok(text.startsWith("大家好嗯我们聊聊"), text);
  near(cut.subtitles[0].end, 2.6 - 0.7);
});
