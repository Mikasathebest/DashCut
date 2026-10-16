// Provider adapters for the in-app editing agent. Each adapter exposes one normalized
// `complete({ system, messages, tools, signal })` so the runtime never sees wire formats.
// Credentials and request bodies are never placed in errors or logs.

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_MAX_TOKENS = 4096;
const REQUEST_TIMEOUT_MS = 180_000;

function normalizeBaseUrl(value, fallback) {
  const base = new URL(typeof value === "string" && value.trim() ? value.trim() : fallback);
  // Plain HTTP is only allowed for model servers on this machine (Ollama, LM Studio, test doubles).
  const loopback = base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  if ((base.protocol !== "https:" && !loopback) || base.username || base.password || base.search || base.hash) {
    throw new Error("接口地址必须是 HTTPS API base URL（本机模型服务可用 http://127.0.0.1；不包含密钥或查询参数）");
  }
  return base.href.replace(/\/+$/, "");
}

function requireKey(value) {
  const apiKey = typeof value === "string" ? value.trim() : "";
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error("请先配置 API Key");
  return apiKey;
}

function statusHint(status) {
  if (status === 401 || status === 403) return "：请检查 API Key";
  if (status === 404) return "：模型或接口地址不存在";
  if (status === 429) return "：请求过于频繁或额度不足，请稍后重试";
  if (status === 400) return "：模型不接受该请求格式";
  if (status >= 500) return "：服务暂时不可用，请稍后重试";
  return "：请求失败";
}

function combinedSignal(signal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function postJson(fetchImpl, url, headers, body, signal, label) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: combinedSignal(signal),
      redirect: "error",
    });
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (error?.name === "TimeoutError") throw new Error(`${label} 请求超时`);
    throw new Error(`${label} 网络请求失败`);
  }
  // Never surface the response body either: gateways sometimes echo the request (incl. headers).
  if (!response.ok) {
    const error = new Error(`${label} HTTP ${response.status}${statusHint(response.status)}`);
    error.status = response.status;
    throw error;
  }
  try { return await response.json(); }
  catch { throw new Error(`${label} 返回了无效的 JSON`); }
}

function abortError() {
  const error = new Error("已取消");
  error.name = "AbortError";
  return error;
}

// Parse model-produced tool arguments. Repairs trivial issues (code fences, trailing commas);
// otherwise returns { __invalid: raw } so the runtime can report the problem to the model.
function parseToolArguments(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (raw == null || (typeof raw === "string" && !raw.trim())) return {};
  if (typeof raw !== "string") return { __invalid: String(raw) };
  const attempts = [raw];
  let repaired = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  attempts.push(repaired);
  repaired = repaired.replace(/,\s*([}\]])/g, "$1");
  attempts.push(repaired);
  for (const candidate of attempts) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch { /* try next */ }
  }
  return { __invalid: raw };
}

function toolResultContent(content) {
  return typeof content === "string" ? content : JSON.stringify(content ?? null);
}

function createOpenAIProvider(config, fetchImpl) {
  const baseUrl = normalizeBaseUrl(config.baseUrl, DEFAULT_OPENAI_BASE_URL);
  const apiKey = requireKey(config.apiKey);
  const model = typeof config.model === "string" && config.model.trim() ? config.model.trim() : "";
  if (!model) throw new Error("请选择模型");

  function toWire(system, messages) {
    const wire = [];
    if (system) wire.push({ role: "system", content: system });
    for (const message of messages) {
      if (message.role === "user") wire.push({ role: "user", content: message.content });
      else if (message.role === "assistant") {
        const entry = { role: "assistant", content: message.content || "" };
        if (message.toolCalls?.length) {
          if (!message.content) entry.content = null;
          entry.tool_calls = message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments?.__invalid ?? JSON.stringify(call.arguments ?? {}) },
          }));
        }
        wire.push(entry);
      } else if (message.role === "tool") {
        wire.push({ role: "tool", tool_call_id: message.toolCallId, content: toolResultContent(message.content) });
      }
    }
    return wire;
  }

  return {
    kind: "openai",
    model,
    async complete({ system, messages = [], tools = [], signal } = {}) {
      const body = { model, messages: toWire(system, messages), temperature: 0.2 };
      if (tools.length) {
        body.tools = tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
        body.tool_choice = "auto";
      }
      const data = await postJson(fetchImpl, `${baseUrl}/chat/completions`, { Authorization: `Bearer ${apiKey}` }, body, signal, "模型接口");
      const choice = data?.choices?.[0];
      if (!choice?.message) throw new Error("模型接口返回格式无效");
      const toolCalls = (choice.message.tool_calls || []).filter((call) => call?.function?.name).map((call, index) => ({
        id: call.id || `call_${Date.now()}_${index}`,
        name: call.function.name,
        arguments: parseToolArguments(call.function.arguments),
      }));
      const text = typeof choice.message.content === "string" ? choice.message.content : "";
      return { text, toolCalls, stopReason: choice.finish_reason || null, usage: data.usage || null };
    },
  };
}

function createAnthropicProvider(config, fetchImpl) {
  const baseUrl = normalizeBaseUrl(config.baseUrl, DEFAULT_ANTHROPIC_BASE_URL);
  const apiKey = requireKey(config.apiKey);
  const model = typeof config.model === "string" && config.model.trim() ? config.model.trim() : DEFAULT_ANTHROPIC_MODEL;
  const endpoint = /\/v1$/.test(baseUrl) ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`;

  function toWire(messages) {
    const wire = [];
    const push = (role, blocks) => {
      const last = wire[wire.length - 1];
      // Consecutive same-role turns (e.g. several tool results) are merged into one message.
      if (last && last.role === role) last.content.push(...blocks);
      else wire.push({ role, content: blocks });
    };
    for (const message of messages) {
      if (message.role === "user") push("user", [{ type: "text", text: message.content }]);
      else if (message.role === "assistant") {
        // Replay the original content blocks (incl. thinking) when available, unchanged.
        if (Array.isArray(message.anthropicContent) && message.anthropicContent.length) {
          push("assistant", message.anthropicContent.map((block) => ({ ...block })));
          continue;
        }
        const blocks = [];
        if (message.content) blocks.push({ type: "text", text: message.content });
        for (const call of message.toolCalls || []) {
          blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments?.__invalid !== undefined ? {} : call.arguments || {} });
        }
        if (blocks.length) push("assistant", blocks);
      } else if (message.role === "tool") {
        const block = { type: "tool_result", tool_use_id: message.toolCallId, content: toolResultContent(message.content) };
        if (message.isError) block.is_error = true;
        push("user", [block]);
      }
    }
    return wire;
  }

  return {
    kind: "anthropic",
    model,
    async complete({ system, messages = [], tools = [], signal } = {}) {
      const body = { model, max_tokens: ANTHROPIC_MAX_TOKENS, messages: toWire(messages) };
      if (system) body.system = system;
      if (tools.length) {
        body.tools = tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters || { type: "object", properties: {} } }));
        body.tool_choice = { type: "auto" };
      }
      const data = await postJson(fetchImpl, endpoint, { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION }, body, signal, "Claude 接口");
      if (!Array.isArray(data?.content)) throw new Error("Claude 接口返回格式无效");
      if (data.stop_reason === "refusal") throw new Error("Claude 拒绝了该请求");
      const text = data.content.filter((block) => block.type === "text").map((block) => block.text).join("");
      const toolCalls = data.content.filter((block) => block.type === "tool_use").map((block) => ({
        id: block.id, name: block.name, arguments: parseToolArguments(block.input),
      }));
      return { text, toolCalls, stopReason: data.stop_reason || null, usage: data.usage || null, anthropicContent: data.content };
    },
  };
}

function createProvider(config = {}) {
  const fetchImpl = typeof config.fetch === "function" ? config.fetch : fetch;
  if (config.kind === "openai") return createOpenAIProvider(config, fetchImpl);
  if (config.kind === "anthropic") return createAnthropicProvider(config, fetchImpl);
  throw new Error("不支持的模型提供方");
}

module.exports = {
  ANTHROPIC_MAX_TOKENS,
  ANTHROPIC_VERSION,
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_BASE_URL,
  createProvider,
  parseToolArguments,
};
