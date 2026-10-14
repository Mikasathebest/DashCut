import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { AUDIO_MODELS, DEFAULT_MODEL, isSilentWav, listHubModels, translateSubtitles, transcribeHub, validateAudioSegments, wavDuration } = require("../electron/AI API.cjs");
const config = { baseUrl: "https://api.example.com/v1", apiKey: "test-secret", model: DEFAULT_MODEL };
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

test("discovers the authenticated catalog without claiming all chat models support audio", async () => {
  const models = await listHubModels(config, { fetchImpl: async (url, request) => {
    assert.equal(url, `${config.baseUrl}/models`);
    assert.equal(request.headers.Authorization, "Bearer test-secret");
    assert.equal(request.redirect, "error");
    return new Response(JSON.stringify({ data: [{ id: AUDIO_MODELS[0], mode: "chat" }, { id: DEFAULT_MODEL, mode: "chat" }, { id: "speech", mode: "realtime" }] }));
  } });
  assert.deepEqual(models.map((item) => item.audioTested), [true, false, false]);
});

test("bilingual translation preserves exact ASR timings and IDs despite response reordering", async () => {
  const translated = await translateSubtitles({ config, subtitles: captions }, { fetchImpl: async (url, request) => {
    assert.equal(url, `${config.baseUrl}/chat/completions`);
    const body = JSON.parse(request.body);
    assert.equal(body.model, DEFAULT_MODEL);
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
    await assert.rejects(translateSubtitles({ config, subtitles: captions }, { fetchImpl: async () => completion({ segments }) }));
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
  await assert.rejects(listHubModels(config, { fetchImpl: async () => new Response("test-secret and base64-audio", { status: 400 }) }), (error) => !/test-secret|base64-audio/.test(error.message) && /400/.test(error.message));
  await assert.rejects(listHubModels({ ...config, baseUrl: "http://insecure/v1" }), /HTTPS/);
  await assert.rejects(listHubModels({ ...config, apiKey: "" }), /API Key/);
});

test("checks WAV duration and digital silence independently of model output", () => {
  assert.equal(wavDuration(wav(3)), 3);
  assert.equal(isSilentWav(wav(3)), true);
  assert.equal(isSilentWav(wav(1, 1000)), false);
  assert.throws(() => wavDuration(Buffer.from("not WAV")), /WAV/);
  assert.throws(() => wavDuration(wav(1).subarray(0, 60)), /完整/);
});

test("rejects hallucinated, overlapping, negative and out-of-bounds timestamps", () => {
  const segment = { start: 0.25, end: 2, text: "Hello", zh: "你好", en: "Hello" };
  assert.equal(validateAudioSegments({ segments: [segment] }, 3, 30)[0].start, 30.25);
  assert.deepEqual(validateAudioSegments({ segments: [] }, 3), []);
  for (const change of [{ start: -1 }, { end: 13.3 }, { end: 0 }, { text: "" }, { start: "0" }]) {
    assert.throws(() => validateAudioSegments({ segments: [{ ...segment, ...change }] }, 3));
  }
  assert.throws(() => validateAudioSegments({ segments: [segment, segment] }, 3));
});

test("cloud pipeline skips silent chunks, measures chunk offsets and cleans temporary audio", async () => {
  const tempPath = await mkdtemp(path.join(os.tmpdir(), "dashcut-hub-test-"));
  const sourcePath = path.join(tempPath, "source video.wav");
  await writeFile(sourcePath, wav(2));
  let requests = 0;
  try {
    const result = await transcribeHub({ config: { ...config, model: AUDIO_MODELS[0] }, clips: [{ id: 4, path: sourcePath }] }, {
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
    await assert.rejects(transcribeHub({ config: { ...config, model: AUDIO_MODELS[0] }, clips: [{ id: 1, path: sourcePath }] }, {
      tempPath,
      execFileImpl: async (_executable, args) => writeFile(path.join(path.dirname(args.at(-1)), "000000.wav"), wav(1, 1000)),
      fetchImpl: async () => new Response("error", { status: 500 }),
    }), /500/);
    assert.deepEqual(await readdir(tempPath), ["source.wav"]);
  } finally { await rm(tempPath, { recursive: true, force: true }); }
});
