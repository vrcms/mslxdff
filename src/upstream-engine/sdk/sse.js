// AI SDK parts → OpenAI SSE 帧（供 reshape/转发链按原生 workbuddy 帧同等处理）。
// 纯函数序列化器：push(part) 返回该 part 产生的 SSE 文本（可能为空串/组合帧），end() 返回 [DONE]。
// 见 .scratch/workbuddy-sdk-channel/SPEC.md。

// 数值兼容：扁平 number / { total } 嵌套
function pickTokens(v) {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && typeof v.total === "number") return v.total;
  return undefined;
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function usageToOpenAI(u) {
  if (!u || typeof u !== "object") return undefined;
  const raw = u.raw && typeof u.raw === "object" ? u.raw : null;
  // raw 已是 OpenAI chat 口径 → 直接用（最保真）
  if (raw && (raw.prompt_tokens != null || raw.completion_tokens != null || raw.total_tokens != null)) return raw;
  // 否则从 raw（Responses 口径 input_tokens/output_tokens）或 V2 扁平 / V3 嵌套标准字段归一
  const src = raw || u;
  const prompt = num(src.input_tokens) ?? pickTokens(src.inputTokens) ?? pickTokens(u.inputTokens) ?? 0;
  const completion = num(src.output_tokens) ?? pickTokens(src.outputTokens) ?? pickTokens(u.outputTokens) ?? 0;
  const total = num(src.total_tokens) ?? num(src.totalTokens) ?? pickTokens(u.totalTokens) ?? (prompt + completion);
  const out = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
  // Responses 口径的 details 映射到 OpenAI chat details（有则带上）
  const cached = num(src.input_tokens_details?.cached_tokens ?? src.prompt_tokens_details?.cached_tokens);
  if (cached != null) out.prompt_tokens_details = { cached_tokens: cached };
  const reasoningTokens = num(src.output_tokens_details?.reasoning_tokens ?? src.completion_tokens_details?.reasoning_tokens);
  if (reasoningTokens != null) out.completion_tokens_details = { reasoning_tokens: reasoningTokens };
  return out;
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
        // V2 spec 的 finishReason 是字符串；V3 spec 是 { unified, raw }
        const fr = part.finishReason;
        const raw = typeof fr === "string" ? fr : (fr?.raw ?? fr?.unified);
        const reason = raw === "tool-calls" ? "tool_calls" : raw === "content-filter" ? "content_filter" : (raw ?? "stop");
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
