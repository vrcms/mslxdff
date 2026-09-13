// AI SDK parts → OpenAI SSE 帧（供 reshape/转发链按原生 workbuddy 帧同等处理）。
// 纯函数序列化器：push(part) 返回该 part 产生的 SSE 文本（可能为空串/组合帧），end() 返回 [DONE]。
// 见 .scratch/workbuddy-sdk-channel/SPEC.md。

export function usageToOpenAI(u) {
  if (!u || typeof u !== "object") return undefined;
  if (u.raw && typeof u.raw === "object") return u.raw;
  const prompt = u.inputTokens?.total ?? 0;
  const completion = u.outputTokens?.total ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

export function createSseSerializer() {
  const meta = { id: "chatcmpl-wb-sdk", model: "", created: Math.floor(Date.now() / 1000) };
  let roleSent = false;
  let nextIndex = 0;
  const toolIndex = new Map();
  const toolDeltaIds = new Set();

  function frame(delta, { finishReason = null, usage } = {}) {
    const obj = {
      id: meta.id,
      object: "chat.completion.chunk",
      created: meta.created,
      model: meta.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage !== undefined) obj.usage = usage;
    return `data: ${JSON.stringify(obj)}\n\n`;
  }

  function ensureRole() {
    if (roleSent) return "";
    roleSent = true;
    return frame({ role: "assistant" });
  }

  function push(part) {
    if (!part || typeof part !== "object") return null;
    switch (part.type) {
      case "response-metadata": {
        if (part.id) meta.id = String(part.id);
        if (part.modelId) meta.model = String(part.modelId);
        if (part.timestamp) {
          const t = new Date(part.timestamp).getTime();
          if (Number.isFinite(t)) meta.created = Math.floor(t / 1000);
        }
        return null;
      }
      case "reasoning-delta":
        return ensureRole() + frame({ reasoning_content: String(part.delta ?? "") });
      case "text-delta":
        return ensureRole() + frame({ content: String(part.delta ?? "") });
      case "tool-input-start": {
        const idx = nextIndex++;
        toolIndex.set(part.id, idx);
        toolDeltaIds.add(part.id);
        return ensureRole() + frame({
          tool_calls: [{ index: idx, id: part.id, type: "function", function: { name: part.toolName || "", arguments: "" } }],
        });
      }
      case "tool-input-delta": {
        const idx = toolIndex.has(part.id) ? toolIndex.get(part.id) : 0;
        return frame({ tool_calls: [{ index: idx, function: { arguments: String(part.delta ?? "") } }] });
      }
      case "tool-call": {
        const id = part.toolCallId;
        const idx = toolIndex.has(id) ? toolIndex.get(id) : nextIndex++;
        toolIndex.set(id, idx);
        if (toolDeltaIds.has(id)) return null;
        const args = typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {});
        return ensureRole() + frame({ tool_calls: [{ index: idx, id, type: "function", function: { name: part.toolName || "", arguments: args } }] });
      }
      case "finish": {
        const reason = part.finishReason?.raw ?? part.finishReason?.unified ?? "stop";
        return frame({}, { finishReason: reason, usage: usageToOpenAI(part.usage) });
      }
      case "error": {
        const message = part.error?.message
          || (typeof part.error === "string" ? part.error : JSON.stringify(part.error ?? "unknown error"));
        return `data: ${JSON.stringify({ error: { message } })}\n\n`;
      }
      default:
        return null;
    }
  }

  function end() {
    return "data: [DONE]\n\n";
  }

  return { push, end };
}
