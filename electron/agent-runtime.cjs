// Main-process LLM loop for the editing agent. The renderer owns the project and executes
// tools (via `callTool`); this loop only talks to the provider and relays events.

const MAX_TOOL_RESULT_CHARS = 24_000;
const TRUNCATED_PREVIEW_CHARS = 20_000;

function serializeResult(result) {
  let json;
  try { json = JSON.stringify(result === undefined ? null : result); }
  catch { json = JSON.stringify({ error: "工具结果无法序列化" }); }
  if (json.length <= MAX_TOOL_RESULT_CHARS) return json;
  return JSON.stringify({ truncated: true, preview: json.slice(0, TRUNCATED_PREVIEW_CHARS) });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function runAgent({ provider, system, history = [], userMessage, tools = [], callTool, onEvent = () => {}, signal, maxSteps = 24 } = {}) {
  const messages = [...history];
  if (typeof userMessage === "string" && userMessage.length) messages.push({ role: "user", content: userMessage });
  const emit = (event) => { try { onEvent(event); } catch { /* listener errors never break the loop */ } };
  const stopped = () => { emit({ type: "stopped" }); return messages; };

  for (let step = 0; step < maxSteps; step += 1) {
    if (signal?.aborted) return stopped();
    let response;
    try {
      response = await provider.complete({ system, messages, tools, signal });
    } catch (error) {
      if (signal?.aborted) return stopped();
      emit({ type: "error", message: errorMessage(error) });
      return messages;
    }
    if (signal?.aborted) return stopped();

    const text = response.text || "";
    const toolCalls = response.toolCalls || [];
    const assistant = { role: "assistant", content: text, toolCalls };
    if (response.anthropicContent) assistant.anthropicContent = response.anthropicContent;
    messages.push(assistant);
    if (text.trim()) emit({ type: "assistant", text });

    if (!toolCalls.length) {
      emit({ type: "done", text });
      return messages;
    }

    for (const call of toolCalls) {
      if (signal?.aborted) {
        // Keep history well-formed: every tool call gets a result.
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify({ error: "已被用户停止" }) });
        continue;
      }
      emit({ type: "tool-call", id: call.id, name: call.name, arguments: call.arguments });
      let result;
      let isError = false;
      if (call.arguments && Object.prototype.hasOwnProperty.call(call.arguments, "__invalid")) {
        result = { error: "参数不是有效的 JSON", raw: String(call.arguments.__invalid).slice(0, 2000) };
        isError = true;
      } else {
        try {
          result = await callTool(call.name, call.arguments || {}, { signal });
        } catch (error) {
          result = { error: errorMessage(error) };
          isError = true;
        }
      }
      const content = serializeResult(result);
      emit({ type: "tool-result", id: call.id, name: call.name, result: JSON.parse(content) });
      const toolMessage = { role: "tool", toolCallId: call.id, name: call.name, content };
      if (isError) toolMessage.isError = true;
      messages.push(toolMessage);
    }
    if (signal?.aborted) return stopped();
  }
  emit({ type: "error", message: "步骤过多，已停止" });
  return messages;
}

module.exports = { MAX_TOOL_RESULT_CHARS, TRUNCATED_PREVIEW_CHARS, runAgent, serializeResult };
