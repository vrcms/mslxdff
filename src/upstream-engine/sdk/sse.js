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

export function createSseSerializer(captured = null) {
  const meta = { id: "chatcmpl-wb-sdk", model: "", created: Math.floor(Date.now() / 1000) };
  let roleSent = false;
  let nextIndex = 0;
  const toolIndex = new Map();
  const toolDeltaIds = new Set();
  // 「当前正在流式输入的工具」的 index：无 id 的 tool-input-delta 靠它归位（见该 case 的注释）
  let lastToolIdx = null;
  // 加密思考往返：reasoning-start 的 providerMetadata 带 itemId + 加密态，随首帧透出
  let reasoningMeta = null;
  let reasoningFrameSent = false;
  let reasoningEncSent = false;

  function frame(delta, { finishReason = null, usage, extra } = {}) {
    const obj = {
      id: meta.id,
      object: "chat.completion.chunk",
      created: meta.created,
      model: meta.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage !== undefined) obj.usage = usage;
    if (extra) Object.assign(obj, extra);
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
      case "reasoning-start": {
        const pm = part.providerMetadata?.openai || part.providerMetadata || {};
        reasoningMeta = {
          id: String(pm.itemId ?? part.id ?? "reasoning"),
          encrypted: typeof pm.reasoningEncryptedContent === "string" ? pm.reasoningEncryptedContent : null,
        };
        // 即时透出 item 元数据（含加密态）：上游可能只给 encrypted 不给 summary 文本，不能等 delta
        reasoningFrameSent = true;
        if (reasoningMeta.encrypted) reasoningEncSent = true;
        return ensureRole() + frame({ reasoning_content: "" }, { extra: { x_reasoning_item: { id: reasoningMeta.id, encrypted_content: reasoningMeta.encrypted } } });
      }
      case "reasoning-delta": {
        const delta = String(part.delta ?? "");
        let extra;
        if (reasoningMeta && !reasoningFrameSent) {
          reasoningFrameSent = true;
          if (reasoningMeta.encrypted) reasoningEncSent = true;
          // x_reasoning_item：responses translator 据此建 reasoning item（chat 客户端忽略未知顶层字段）
          extra = { x_reasoning_item: { id: reasoningMeta.id, encrypted_content: reasoningMeta.encrypted } };
        } else if (reasoningMeta) {
          extra = { x_reasoning_id: reasoningMeta.id };
        }
        return ensureRole() + frame({ reasoning_content: delta }, { extra });
      }
      case "text-delta":
        return ensureRole() + frame({ content: String(part.delta ?? "") });
      case "tool-input-start": {
        const idx = nextIndex++;
        toolIndex.set(part.id, idx);
        toolDeltaIds.add(part.id);
        lastToolIdx = idx;   // 后续无 id 的 delta 归到这个工具
        return ensureRole() + frame({
          tool_calls: [{ index: idx, id: part.id, type: "function", function: { name: part.toolName || "", arguments: "" } }],
        });
      }
      case "tool-input-delta": {
        // 未知 id **绝不能回退到 index 0**：那会把这段参数写进另一个工具（实测：callA 占 index 0 时，
        // 一个 id 丢失的 delta 让 funcA 的参数变成 `{"hijack":true}`），客户端会拿着被污染的参数去调用
        // 错误的函数。改为按 `tool-call` 分支的口径分配新 index —— 宁可多一个空工具槽，也不污染已有工具。
        // 无 id 的 delta 属于「当前正在流式输入的那个工具」：复用上一次用过的 index。
        // 每个都分配新 index 会把一段参数拆成多个工具（实测：无 id 的 `{"a":` 与 `1}` 分别落到
        // index 1 和 2，两个都是非法 JSON）—— 比旧代码的「都落 index 0」更糟。
        let idx;
        if (part.id && toolIndex.has(part.id)) idx = toolIndex.get(part.id);
        else if (!part.id && lastToolIdx != null) idx = lastToolIdx;   // 无 id：沿用当前工具
        else { idx = nextIndex++; if (part.id) toolIndex.set(part.id, idx); }
        lastToolIdx = idx;
        return frame({ tool_calls: [{ index: idx, function: { arguments: String(part.delta ?? "") } }] });
      }
      case "tool-call": {
        const id = part.toolCallId;
        const idx = toolIndex.has(id) ? toolIndex.get(id) : nextIndex++;
        toolIndex.set(id, idx);
        lastToolIdx = idx;   // 同 tool-input-start：后续无 id 的 delta 归到这个工具
        if (toolDeltaIds.has(id)) return null;
        const args = typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {});
        return ensureRole() + frame({ tool_calls: [{ index: idx, id, type: "function", function: { name: part.toolName || "", arguments: args } }] });
      }
      case "finish": {
        // V2 spec 的 finishReason 是字符串；V3 spec 是 { unified, raw }
        const fr = part.finishReason;
        const raw = typeof fr === "string" ? fr : (fr?.raw ?? fr?.unified);
        const reason = raw === "tool-calls" ? "tool_calls" : raw === "content-filter" ? "content_filter" : (raw ?? "stop");
        // 加密思考补发：上游 encrypted_content 只在流末尾可得（fetch 侧信道捕获），
        // 无 summary 文本时 AI SDK parts 不会带出 → 收尾帧前补一帧
        let pre = "";
        if (captured?.reasoning && !reasoningEncSent) {
          reasoningEncSent = true;
          pre = ensureRole() + frame({ reasoning_content: "" }, { extra: { x_reasoning_item: { id: captured.reasoning.id, encrypted_content: captured.reasoning.encrypted } } });
        }
        return pre + frame({}, { finishReason: reason, usage: usageToOpenAI(part.usage) });
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
