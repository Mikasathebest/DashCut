/* eslint-disable @typescript-eslint/no-require-imports */
// Hosts the editing agent in the main process. The renderer owns the project, so every tool
// call is forwarded to it and answered over IPC; the main process only runs the model loop.
const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { createKeyStore } = require("./agent-keys.cjs");
const { createProvider, DEFAULT_ANTHROPIC_MODEL } = require("./agent-providers.cjs");
const { runAgent } = require("./agent-runtime.cjs");
const { atomicWrite } = require("./project-store.cjs");

const toolTimeoutMs = 10 * 60_000; // plan approval waits for the user

function createAgentHost({ ipcMain, safeStorage, configFile, keyFile, getWindow }) {
  const keys = createKeyStore({ file: keyFile, safeStorage });
  const pending = new Map();
  let history = [];
  let controller = null;

  async function readConfig() {
    try {
      const saved = JSON.parse(await readFile(configFile, "utf8"));
      return { kind: saved.kind === "anthropic" ? "anthropic" : "openai", baseUrl: String(saved.baseUrl ?? ""), model: String(saved.model ?? "") };
    } catch {
      return { kind: "anthropic", baseUrl: "", model: DEFAULT_ANTHROPIC_MODEL };
    }
  }

  function send(channel, payload) {
    getWindow()?.webContents.send(channel, payload);
  }

  function callRenderer(name, args, signal) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(() => reject(new Error("工具执行超时"))), toolTimeoutMs);
      const onAbort = () => finish(() => reject(new Error("已被用户停止")));
      function finish(action) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        pending.delete(requestId);
        action();
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      pending.set(requestId, (response) => finish(() => response.error ? reject(new Error(response.error)) : resolve(response.result)));
      send("agent:tool-request", { requestId, name, args });
    });
  }

  ipcMain.handle("agent:tool-response", (_event, response) => {
    pending.get(response?.requestId)?.(response);
  });

  ipcMain.handle("agent:config", async () => {
    const config = await readConfig();
    return { ...config, hasKey: { openai: keys.has("openai"), anthropic: keys.has("anthropic") }, persistentKeys: keys.persistent() };
  });

  ipcMain.handle("agent:save-config", async (_event, { kind, baseUrl, model, apiKey }) => {
    const config = { kind: kind === "anthropic" ? "anthropic" : "openai", baseUrl: String(baseUrl ?? "").trim(), model: String(model ?? "").trim() };
    await atomicWrite(configFile, JSON.stringify(config, null, 2));
    // An empty key field means "keep the stored key"; keys are never sent back to the renderer.
    if (typeof apiKey === "string" && apiKey.trim()) await keys.set(config.kind, apiKey.trim());
    return { ...config, hasKey: { openai: keys.has("openai"), anthropic: keys.has("anthropic") }, persistentKeys: keys.persistent() };
  });

  ipcMain.handle("agent:clear-key", async (_event, kind) => {
    await keys.clear(kind === "anthropic" ? "anthropic" : "openai");
  });

  ipcMain.handle("agent:reset", () => {
    controller?.abort();
    history = [];
  });

  ipcMain.handle("agent:stop", () => {
    controller?.abort();
  });

  ipcMain.handle("agent:send", async (_event, { message, system, tools }) => {
    if (controller) throw new Error("助手正在执行，请先停止");
    const config = await readConfig();
    const apiKey = keys.get(config.kind);
    if (!apiKey) throw new Error("请先在助手设置中填写 API Key");
    const provider = createProvider({ ...config, baseUrl: config.baseUrl || undefined, model: config.model || undefined, apiKey });
    controller = new AbortController();
    const runId = randomUUID();
    send("agent:event", { runId, type: "start" });
    try {
      history = await runAgent({
        provider,
        system,
        history,
        userMessage: String(message ?? ""),
        tools: Array.isArray(tools) ? tools : [],
        signal: controller.signal,
        callTool: (name, args, context) => callRenderer(name, args, context?.signal ?? controller?.signal),
        onEvent: (event) => send("agent:event", { runId, ...event }),
      });
    } finally {
      controller = null;
      send("agent:event", { runId, type: "end" });
    }
    return { runId };
  });

  return { keys };
}

module.exports = { createAgentHost };
