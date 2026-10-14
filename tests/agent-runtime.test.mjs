import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createProvider, parseToolArguments, DEFAULT_ANTHROPIC_MODEL } = require("../electron/agent-providers.cjs");
const { runAgent } = require("../electron/agent-runtime.cjs");
const { createKeyStore } = require("../electron/agent-keys.cjs");

const tools = [{ name: "split_clip", description: "Split a clip", parameters: { type: "object", properties: { clipId: { type: "string" }, at: { type: "number" } }, required: ["clipId", "at"] } }];
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

function recorder(responses) {
  const calls = [];
  const fetchImpl = async (url, request) => {
    calls.push({ url, request, body: JSON.parse(request.body) });
    const next = responses.shift();
    return typeof next === "function" ? next() : next;
  };
  return { calls, fetchImpl };
}

test("openai provider sends chat completions request and parses tool calls", async () => {
  const { calls, fetchImpl } = recorder([json({
    choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [
      { id: "c1", type: "function", function: { name: "split_clip", arguments: "{\"clipId\":\"a\",\"at\":2}" } },
      { id: "c2", type: "function", function: { name: "split_clip", arguments: "```json\n{\"clipId\":\"b\",\"at\":3,}\n```" } },
      { id: "c3", type: "function", function: { name: "split_clip", arguments: "{clipId: oops" } },
    ] } }],
    usage: { total_tokens: 10 },
  })]);
  const provider = createProvider({ kind: "openai", baseUrl: "https://api.example.com/v1/", apiKey: "sk-secret", model: "m1", fetch: fetchImpl });
  const result = await provider.complete({
    system: "sys",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "c0", name: "split_clip", arguments: { clipId: "x", at: 1 } }] },
      { role: "tool", toolCallId: "c0", name: "split_clip", content: "{\"ok\":true}" },
    ],
    tools,
  });
  const [{ url, request, body }] = calls;
  assert.equal(url, "https://api.example.com/v1/chat/completions");
  assert.equal(request.headers.Authorization, "Bearer sk-secret");
  assert.equal(body.model, "m1");
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.temperature, 0.2);
  assert.deepEqual(body.tools[0], { type: "function", function: { name: "split_clip", description: "Split a clip", parameters: tools[0].parameters } });
  assert.deepEqual(body.messages[0], { role: "system", content: "sys" });
  assert.equal(body.messages[2].tool_calls[0].function.arguments, "{\"clipId\":\"x\",\"at\":1}");
  assert.deepEqual(body.messages[3], { role: "tool", tool_call_id: "c0", content: "{\"ok\":true}" });
  assert.deepEqual(result.toolCalls[0], { id: "c1", name: "split_clip", arguments: { clipId: "a", at: 2 } });
  assert.deepEqual(result.toolCalls[1].arguments, { clipId: "b", at: 3 });
  assert.deepEqual(result.toolCalls[2].arguments, { __invalid: "{clipId: oops" });
  assert.equal(result.stopReason, "tool_calls");
  assert.deepEqual(result.usage, { total_tokens: 10 });
});

test("provider errors never leak the api key or request body", async () => {
  const { fetchImpl } = recorder([new Response("echo sk-secret body", { status: 401 })]);
  const provider = createProvider({ kind: "openai", baseUrl: "https://x.test/v1", apiKey: "sk-secret", model: "m", fetch: fetchImpl });
  await assert.rejects(provider.complete({ messages: [{ role: "user", content: "secret prompt" }] }), (error) => {
    assert.match(error.message, /HTTP 401/);
    assert.doesNotMatch(error.message, /sk-secret|secret prompt/);
    return true;
  });
  assert.throws(() => createProvider({ kind: "openai", baseUrl: "http://x.test/v1", apiKey: "k", model: "m" }), /HTTPS/);
  assert.doesNotThrow(() => createProvider({ kind: "openai", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "k", model: "m" }));
  assert.throws(() => createProvider({ kind: "openai", baseUrl: "http://192.168.1.5/v1", apiKey: "k", model: "m" }), /HTTPS/);
});

test("anthropic provider sends messages request with merged tool results", async () => {
  const content = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "Splitting." }, { type: "tool_use", id: "tu2", name: "split_clip", input: { clipId: "c", at: 4 } }];
  const { calls, fetchImpl } = recorder([json({ content, stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 7 } })]);
  const provider = createProvider({ kind: "anthropic", apiKey: "ak-secret", fetch: fetchImpl });
  const result = await provider.complete({
    system: "sys",
    messages: [
      { role: "user", content: "split both" },
      { role: "assistant", content: "ok", toolCalls: [{ id: "tu0", name: "split_clip", arguments: { clipId: "a", at: 1 } }, { id: "tu1", name: "split_clip", arguments: { clipId: "b", at: 2 } }] },
      { role: "tool", toolCallId: "tu0", name: "split_clip", content: "{\"ok\":true}" },
      { role: "tool", toolCallId: "tu1", name: "split_clip", content: "{\"error\":\"x\"}", isError: true },
    ],
    tools,
  });
  const [{ url, request, body }] = calls;
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(request.headers["x-api-key"], "ak-secret");
  assert.equal(request.headers["anthropic-version"], "2023-06-01");
  assert.equal(request.headers.Authorization, undefined);
  assert.equal(body.model, DEFAULT_ANTHROPIC_MODEL);
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.system, "sys");
  assert.equal(body.temperature, undefined);
  assert.deepEqual(body.tools, [{ name: "split_clip", description: "Split a clip", input_schema: tools[0].parameters }]);
  assert.equal(body.messages.length, 3);
  assert.deepEqual(body.messages[1].content, [
    { type: "text", text: "ok" },
    { type: "tool_use", id: "tu0", name: "split_clip", input: { clipId: "a", at: 1 } },
    { type: "tool_use", id: "tu1", name: "split_clip", input: { clipId: "b", at: 2 } },
  ]);
  assert.deepEqual(body.messages[2], { role: "user", content: [
    { type: "tool_result", tool_use_id: "tu0", content: "{\"ok\":true}" },
    { type: "tool_result", tool_use_id: "tu1", content: "{\"error\":\"x\"}", is_error: true },
  ] });
  assert.equal(result.text, "Splitting.");
  assert.deepEqual(result.toolCalls, [{ id: "tu2", name: "split_clip", arguments: { clipId: "c", at: 4 } }]);
  assert.equal(result.stopReason, "tool_use");
  assert.deepEqual(result.anthropicContent, content);
});

test("anthropic provider replays original assistant blocks and honors custom base url", async () => {
  const original = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: "t", name: "split_clip", input: {} }];
  const { calls, fetchImpl } = recorder([json({ content: [{ type: "text", text: "done" }], stop_reason: "end_turn" })]);
  const provider = createProvider({ kind: "anthropic", baseUrl: "https://proxy.test/v1/", apiKey: "k", model: "claude-sonnet-5-5", fetch: fetchImpl });
  await provider.complete({ messages: [
    { role: "user", content: "x" },
    { role: "assistant", content: "", toolCalls: [{ id: "t", name: "split_clip", arguments: {} }], anthropicContent: original },
    { role: "tool", toolCallId: "t", name: "split_clip", content: "{}" },
  ] });
  assert.equal(calls[0].url, "https://proxy.test/v1/messages");
  assert.equal(calls[0].body.model, "claude-sonnet-5-5");
  assert.deepEqual(calls[0].body.messages[1].content, original);
});

test("parseToolArguments repairs trivial issues", () => {
  assert.deepEqual(parseToolArguments(""), {});
  assert.deepEqual(parseToolArguments("{\"a\":[1,2,],}"), { a: [1, 2] });
  assert.deepEqual(parseToolArguments("[1]"), { __invalid: "[1]" });
});

function fakeProvider(responses) {
  const seen = [];
  return { seen, async complete({ messages }) { seen.push(structuredClone(messages)); const next = responses.shift(); return typeof next === "function" ? next() : next; } };
}

test("runAgent runs a multi-step tool loop and returns normalized history", async () => {
  const provider = fakeProvider([
    { text: "先切分", toolCalls: [{ id: "1", name: "split_clip", arguments: { clipId: "a", at: 2 } }] },
    { text: "完成", toolCalls: [] },
  ]);
  const events = [];
  const history = [{ role: "user", content: "earlier" }, { role: "assistant", content: "reply", toolCalls: [] }];
  const messages = await runAgent({ provider, system: "s", history, userMessage: "切开", tools, onEvent: (event) => events.push(event), callTool: async (name, args) => ({ ok: true, name, args }) });
  assert.deepEqual(events.map((event) => event.type), ["assistant", "tool-call", "tool-result", "assistant", "done"]);
  assert.deepEqual(events[2], { type: "tool-result", id: "1", name: "split_clip", result: { ok: true, name: "split_clip", args: { clipId: "a", at: 2 } } });
  assert.equal(events[4].text, "完成");
  assert.equal(messages.length, 6);
  assert.deepEqual(messages[2], { role: "user", content: "切开" });
  assert.equal(messages[4].role, "tool");
  assert.equal(messages[4].toolCallId, "1");
  assert.equal(provider.seen[1].length, 5);
  assert.equal(history.length, 2, "input history is not mutated");
});

test("runAgent reports invalid arguments and tool errors back to the model", async () => {
  const provider = fakeProvider([
    { text: "", toolCalls: [{ id: "bad", name: "split_clip", arguments: { __invalid: "{oops" } }, { id: "boom", name: "split_clip", arguments: {} }] },
    { text: "", toolCalls: [] },
  ]);
  let toolRuns = 0;
  const events = [];
  const messages = await runAgent({ provider, userMessage: "x", tools, onEvent: (event) => events.push(event), callTool: async () => { toolRuns += 1; throw new Error("片段不存在"); } });
  assert.equal(toolRuns, 1, "invalid args never reach callTool");
  assert.deepEqual(JSON.parse(messages[2].content), { error: "参数不是有效的 JSON", raw: "{oops" });
  assert.deepEqual(JSON.parse(messages[3].content), { error: "片段不存在" });
  assert.equal(messages[3].isError, true);
  assert.ok(!events.some((event) => event.type === "assistant"), "empty text is not emitted");
  assert.equal(events.at(-1).type, "done");
});

test("runAgent stops cleanly when aborted mid-run", async () => {
  const controller = new AbortController();
  const provider = fakeProvider([
    { text: "", toolCalls: [{ id: "1", name: "split_clip", arguments: {} }, { id: "2", name: "split_clip", arguments: {} }] },
    { text: "never", toolCalls: [] },
  ]);
  const events = [];
  const called = [];
  const messages = await runAgent({ provider, userMessage: "x", tools, signal: controller.signal, onEvent: (event) => events.push(event), callTool: async (name, args, { signal }) => { called.push(signal); controller.abort(); return { ok: true }; } });
  assert.equal(called.length, 1);
  assert.equal(called[0], controller.signal);
  assert.equal(events.at(-1).type, "stopped");
  assert.equal(provider.seen.length, 1);
  assert.deepEqual(messages.filter((message) => message.role === "tool").map((message) => message.toolCallId), ["1", "2"]);

  const aborted = new AbortController();
  const pending = runAgent({ provider: { complete: () => new Promise((resolve, reject) => aborted.signal.addEventListener("abort", () => reject(new Error("aborted")))) }, userMessage: "x", signal: aborted.signal, onEvent: (event) => events.push(event), callTool: async () => ({}) });
  aborted.abort();
  await pending;
  assert.equal(events.at(-1).type, "stopped");
});

test("runAgent enforces maxSteps", async () => {
  const provider = { complete: async () => ({ text: "", toolCalls: [{ id: "loop", name: "split_clip", arguments: {} }] }) };
  const events = [];
  await runAgent({ provider, userMessage: "x", maxSteps: 3, onEvent: (event) => events.push(event), callTool: async () => ({}) });
  assert.equal(events.filter((event) => event.type === "tool-call").length, 3);
  assert.deepEqual(events.at(-1), { type: "error", message: "步骤过多，已停止" });
});

test("runAgent truncates oversized tool results to valid JSON", async () => {
  const provider = fakeProvider([{ text: "", toolCalls: [{ id: "1", name: "split_clip", arguments: {} }] }, { text: "ok", toolCalls: [] }]);
  const messages = await runAgent({ provider, userMessage: "x", callTool: async () => ({ data: "x".repeat(30_000) }) });
  const parsed = JSON.parse(messages[2].content);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.preview.length, 20_000);
  assert.ok(messages[2].content.length < 24_000);
});

test("key store encrypts keys at rest and round-trips", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashcut-keys-"));
  try {
    const file = path.join(dir, "nested", "agent-keys.json");
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`enc:${[...value].reverse().join("")}`),
      decryptString: (buffer) => [...buffer.toString().slice(4)].reverse().join(""),
    };
    const store = createKeyStore({ file, safeStorage });
    assert.equal(store.has("anthropic"), false);
    store.set("anthropic", "sk-ant-plaintext-123");
    store.set("openai", "sk-plain-456");
    const raw = await readFile(file, "utf8");
    assert.doesNotMatch(raw, /sk-ant-plaintext-123|sk-plain-456/);
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["anthropic", "openai"]);
    const reopened = createKeyStore({ file, safeStorage });
    assert.equal(reopened.has("anthropic"), true);
    assert.equal(reopened.get("anthropic"), "sk-ant-plaintext-123");
    reopened.clear("anthropic");
    assert.equal(reopened.get("anthropic"), null);
    assert.equal(createKeyStore({ file, safeStorage }).get("openai"), "sk-plain-456");
    assert.throws(() => reopened.set("gemini", "x"), /不支持/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("key store keeps keys in memory only when encryption is unavailable", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashcut-keys-"));
  try {
    const file = path.join(dir, "agent-keys.json");
    const safeStorage = { isEncryptionAvailable: () => false, encryptString: () => { throw new Error("unavailable"); }, decryptString: () => { throw new Error("unavailable"); } };
    const store = createKeyStore({ file, safeStorage });
    assert.deepEqual(store.set("openai", "sk-memory-only"), { persisted: false });
    assert.equal(store.get("openai"), "sk-memory-only");
    assert.equal(store.has("openai"), true);
    assert.equal(existsSync(file), false);
    assert.equal(createKeyStore({ file, safeStorage }).get("openai"), null);
    store.clear("openai");
    assert.equal(store.has("openai"), false);
    assert.equal(existsSync(file), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
