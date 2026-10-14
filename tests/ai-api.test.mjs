import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { isSilentWav, listModels, repairAudioSegments, transcribeCloud, translateSubtitles, wavDuration } = require("../electron/ai-api.cjs");
const MODEL = "example/chat-model";
const config = { baseUrl: "https://api.example.com/v1", apiKey: "test-secret", model: MODEL };
const captions = [{ id: 5, start: 2.125, end: 4.625, zh: "今天测试字幕，let's start.", en: "" }, { id: 8, start: 7.1, end: 8.9, zh: "", en: "The meeting starts at three." }];
const output = { segments: [{ id: 8, zh: "会议三点开始。", en: "The meeting starts at three." }, { id: 5, zh: "今天测试字幕，我们开始吧。", en: "Today we test subtitles. Let's start." }] };
const completion = (data, finish_reason = "stop") => new Response(JSON.stringify({ choices: [{ finish_reason, message: { content: `\u0060\u0060\u0060json\n${JSON.stringify(data)}\n\u0060\u0060\u0060` } }] }));

function wav(seconds, value = 0) {
  const dataSize = Math.round(seconds * 16000) * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF"); buffer.writeUInt32LE(36 + dataSize, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24); buffer.writeUInt32LE(32000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(dataSize, 40);
  for (let i = 44; i < buffer.length; i += 2) buffer.writeInt16LE(value, i);
  return buffer;
}

test("lists the authenticated model catalog", async () => {
  const models = await listModels(config, { fetchImpl: async (url, request) => {
    assert.equal(url, `${config.baseUrl}/models`);
    assert.equal(request.headers.Authorization, "Bearer test-secret");
    assert.equal(request.redirect, "error");
    return new Response(JSON.stringify({ data: [{ id: MODEL, mode: "chat" }, { id: "speech" }] }));
  } });
  assert.deepEqual(models, [{ id: MODEL, mode: "chat" }, { id: "speech", mode: "unknown" }]);
});

test("bilingual translation preserves exact ASR timings and IDs despite response reordering", async () => {
  const translated = await translateSubtitles({ config, subtitles: captions }, { fetchImpl: async (url, request) => {
    assert.equal(url, `${config.baseUrl}/chat/completions`);
    const body = JSON.parse(request.body);
    assert.equal(body.model, MODEL);
    assert.doesNotMatch(body.messages[0].content, /2\.125|4\.625|test-secret/);
    assert.deepEqual(JSON.parse(body.messages[0].content.split("Input: ")[1]), captions.map(({ id, zh, en }) => ({ id, text: zh || en })));
    return completion(output);
  } });
  assert.deepEqual(translated.map(({ id, start, end }) => ({ id, start, end })), captions.map(({ id, start, end }) => ({ id, start, end })));
  assert.equal(translated[0].en, "Today we test subtitles. Let's start.");
  assert.equal(captions[0].en, "");
});

test("rejects missing, duplicate, invented IDs, empty translations and truncated JSON", async () => {
  for (const segments of [output.segments.slice(0, 1), [output.segments[0], output.segments[0]], output.segments.map((item) => ({ ...item, id: 100 })), output.segments.map((item) => ({ ...item, en: "" }))]) {
    await assert.rejects(translateSubtitles({ config, subtitles: captions }, { retryDelayMs: 0, fetchImpl: async () => completion({ segments }) }));
  }
  await assert.rejects(translateSubtitles({ config, subtitles: captions }, { fetchImpl: async () => completion(output, "length") }), /截断/);
  await assert.rejects(translateSubtitles({ config, subtitles: [...captions, captions[0]] }), /编号/);
});

test("batches long transcripts with stable IDs and immutable timing", async () => {
  const subtitles = Array.from({ length: 45 }, (_, id) => ({ id, start: id * 2, end: id * 2 + 1, zh: "测试", en: "" }));
  let calls = 0;
  const result = await translateSubtitles({ config, subtitles }, { fetchImpl: async (_url, request) => {
    calls++;
    const content = JSON.parse(request.body).messages[0].content;
    const input = JSON.parse(content.split("Input: ")[1]);
    assert.ok(input.length <= 20);
    return completion({ segments: input.map(({ id }) => ({ id, zh: "测试", en: "Test" })) });
  } });
  assert.equal(calls, 3);
  assert.deepEqual(result.map((item) => item.start), subtitles.map((item) => item.start));
});

test("HTTP errors never echo credentials or audio payloads", async () => {
  await assert.rejects(listModels(config, { fetchImpl: async () => new Response("test-secret and base64-audio", { status: 400 }) }), (error) => !/test-secret|base64-audio/.test(error.message) && /400/.test(error.message));
  await assert.rejects(listModels({ ...config, baseUrl: "http://insecure/v1" }), /HTTPS/);
  await assert.rejects(listModels({ ...config, apiKey: "" }), /API Key/);
  await assert.rejects(listModels({ ...config, baseUrl: "" }), /Base URL/);
  await assert.rejects(translateSubtitles({ config: { ...config, model: "" }, subtitles: captions }, { fetchImpl: async () => { throw new Error("must not request"); } }), /模型/);
});

test("checks WAV duration and digital silence independently of model output", () => {
  assert.equal(wavDuration(wav(3)), 3);
  assert.equal(isSilentWav(wav(3)), true);
  assert.equal(isSilentWav(wav(1, 1000)), false);
  assert.throws(() => wavDuration(Buffer.from("not WAV")), /WAV/);
  assert.throws(() => wavDuration(wav(1).subarray(0, 60)), /完整/);
});

test("repairs sloppy model timestamps instead of discarding the chunk", () => {
  const segment = { start: 0.25, end: 2, text: "Hello", zh: "你好", en: "Hello" };
  assert.equal(repairAudioSegments({ segments: [segment] }, 3, 30)[0].start, 30.25);
  assert.deepEqual(repairAudioSegments({ segments: [] }, 3), []);
  // Out-of-range end is clamped; overlaps are pushed after the previous end; empty and inverted entries are dropped.
  const repaired = repairAudioSegments({ segments: [{ ...segment, end: 13.3 }, { ...segment, start: 1, end: 2.5 }, { ...segment, text: "", zh: "", en: "" }, { ...segment, start: 2, end: 1 }] }, 3);
  assert.deepEqual(repaired.map(({ start, end }) => [start, end]), [[0.25, 3]]);
  assert.throws(() => repairAudioSegments({}, 3), /段落/);
});

test("retries transient failures and keeps other chunks when one chunk fails", async () => {
  const tempPath = await mkdtemp(path.join(os.tmpdir(), "dashcut-ai-retry-"));
  const sourcePath = path.join(tempPath, "source.wav");
  await writeFile(sourcePath, wav(1, 1000));
  const calls = new Map();
  const progress = [];
  try {
    const result = await transcribeCloud({ config, clips: [{ id: 1, path: sourcePath }] }, {
      tempPath, retryDelayMs: 0, onProgress: (value) => progress.push(value.progress),
      execFileImpl: async (_executable, args) => {
        const destination = path.dirname(args.at(-1));
        for (const name of ["000000.wav", "000001.wav", "000002.wav"]) await writeFile(path.join(destination, name), wav(2, 1000));
      },
      fetchImpl: async (_url, request) => {
        const key = JSON.parse(request.body).messages[0].content[1].input_audio.data;
        const index = [...new Set([...calls.keys(), key])].indexOf(key);
        calls.set(key, (calls.get(key) ?? 0) + 1);
        if (calls.size === 1 && calls.get(key) === 1) return new Response("busy", { status: 503 });
        return completion({ segments: [{ start: 0.1, end: 1, text: `chunk ${index}`, zh: "好", en: "ok" }] });
      },
    });
    assert.equal(result.failedChunks, 0);
    assert.equal(result.results[0].segments.length, 3);
    assert.deepEqual(result.results[0].segments.map((item) => item.start), [0.1, 2.1, 4.1]);
    assert.equal(progress.at(-1), 1);
  } finally { await rm(tempPath, { recursive: true, force: true }); }
});

test("cloud pipeline skips silent chunks, measures chunk offsets and cleans temporary audio", async () => {
  const tempPath = await mkdtemp(path.join(os.tmpdir(), "dashcut-hub-test-"));
  const sourcePath = path.join(tempPath, "source video.wav");
  await writeFile(sourcePath, wav(2));
  let requests = 0;
  try {
    const result = await transcribeCloud({ config, clips: [{ id: 4, path: sourcePath }] }, {
      tempPath,
      execFileImpl: async (_executable, args) => {
        assert.equal(args[args.indexOf("-i") + 1], sourcePath);
        const destination = path.dirname(args.at(-1));
        await writeFile(path.join(destination, "000000.wav"), wav(30));
        await writeFile(path.join(destination, "000001.wav"), wav(2, 1000));
      },
      fetchImpl: async (_url, request) => {
        requests++;
        const parts = JSON.parse(request.body).messages[0].content;
        assert.equal(parts[1].input_audio.format, "wav");
        return completion({ segments: [{ start: 0.1, end: 1.9, text: "Hello", zh: "你好", en: "Hello" }] });
      },
    });
    assert.equal(requests, 1);
    assert.equal(result.results[0].clipId, 4);
    assert.equal(result.results[0].segments[0].start, 30.1);
    assert.equal(result.timing, "estimated");
    assert.deepEqual(await readdir(tempPath), ["source video.wav"]);
  } finally { await rm(tempPath, { recursive: true, force: true }); }
});

test("cleans extracted audio when inference fails", async () => {
  const tempPath = await mkdtemp(path.join(os.tmpdir(), "dashcut-hub-failure-"));
  const sourcePath = path.join(tempPath, "source.wav");
  await writeFile(sourcePath, wav(1, 1000));
  try {
    await assert.rejects(transcribeCloud({ config, clips: [{ id: 1, path: sourcePath }] }, {
      tempPath, retryDelayMs: 0,
      execFileImpl: async (_executable, args) => writeFile(path.join(path.dirname(args.at(-1)), "000000.wav"), wav(1, 1000)),
      fetchImpl: async () => new Response("error", { status: 500 }),
    }), /500/);
    assert.deepEqual(await readdir(tempPath), ["source.wav"]);
  } finally { await rm(tempPath, { recursive: true, force: true }); }
});
