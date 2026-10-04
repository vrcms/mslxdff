// vendor 自 src/providers/qwenwork/sse.js 的解帧/清洗/聚合段（逐字搬），另并入上游 completions.js 的额度措辞判定。
// 关键：qwenwork 上游的内层 body **本身就是 OpenAI chunk**（不像 qoder 需要转译），
// 外层是 `{"headers":{},"body":"<内层JSON字符串>","statusCodeValue":200}` 的信封。
import { cleanErrorText } from "./http.js";

function fmtBodyText(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return JSON.stringify(value);
  return "";
}

function bodyCodeMessage(raw, status) {
  let inner;
  try {
    inner = JSON.parse(raw);
  } catch {
    return status >= 400 ? `upstream ${status}: ${String(raw).slice(0, 200)}` : "";
  }
  if (!inner || typeof inner !== "object") return "";
  const code = inner.code;
  if (code === "400" || code === "401" || code === "403") {
    return inner.message ? String(inner.message) : `upstream ${code}`;
  }
  if (status >= 400) {
    return inner.message ? String(inner.message) : `upstream ${status}: ${String(raw).slice(0, 200)}`;
  }
  return "";
}

export function unwrapFrame(payload) {
  if (typeof payload !== "string") return { ok: false };
  const text = String(payload).trim();
  if (!text || text === "[DONE]" || text === "{}") return { ok: false };
  let outer;
  try {
    outer = JSON.parse(text);
  } catch {
    return { ok: true, body: text };
  }
  if (!outer || typeof outer !== "object") return { ok: false };
  if (Object.prototype.hasOwnProperty.call(outer, "choices")) return { ok: true, body: text };
  if (outer.object === "chat.completion.chunk" || outer.object === "chat.completion") return { ok: true, body: text };
  if (typeof outer.statusCodeValue === "number" && outer.statusCodeValue >= 400) {
    return { ok: false, error: bodyCodeMessage(fmtBodyText(outer.body), outer.statusCodeValue) };
  }
  if (!Object.prototype.hasOwnProperty.call(outer, "body")) return { ok: false };
  const inner = outer.body;
  if (typeof inner === "string") {
    if (!inner || inner === "[DONE]" || inner === "{}" || inner === "null") return { ok: false };
    const msg = bodyCodeMessage(inner, 0);
    if (msg) return { ok: false, error: msg };
    return { ok: true, body: inner };
  }
  if (inner && typeof inner === "object") {
    const s = JSON.stringify(inner);
    if (s === "{}" || s === "[]") return { ok: false };
    return { ok: true, body: s };
  }
  return { ok: false };
}

function isEmptyValue(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") {
    for (const key of Object.keys(v)) {
      if (!isEmptyValue(v[key])) return false;
    }
    return true;
  }
  return false;
}

export function cleanChunk(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return text;
  }
  if (!obj || typeof obj !== "object") return text;

  if (obj.usage && typeof obj.usage === "object") {
    let changed = false;
    for (const noise of ["raw_usage", "sub_usages"]) {
      if (Object.prototype.hasOwnProperty.call(obj.usage, noise)) {
        delete obj.usage[noise];
        changed = true;
      }
      if (Object.prototype.hasOwnProperty.call(obj, noise)) {
        delete obj[noise];
        changed = true;
      }
    }
    return changed ? JSON.stringify(obj) : text;
  }

  let changed = false;
  if (Array.isArray(obj.choices)) {
    for (const choice of obj.choices) {
      if (!choice || typeof choice !== "object") continue;
      const delta = choice.delta;
      if (!delta || typeof delta !== "object") continue;
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length === 0) {
        delete delta.tool_calls;
        changed = true;
      }
      for (const noise of ["content", "reasoning_content", "function_call", "refusal", "extra_fields"]) {
        if (Object.prototype.hasOwnProperty.call(delta, noise) && isEmptyValue(delta[noise])) {
          delete delta[noise];
          changed = true;
        }
      }
      if (Object.keys(delta).length === 0 && !choice.finish_reason) return "";
    }
  }
  return changed ? JSON.stringify(obj) : text;
}

function mergeToolCallDelta(merged, delta) {
  for (const key of ["id", "type"]) {
    if (merged[key] === undefined && typeof delta[key] === "string" && delta[key] !== "") merged[key] = delta[key];
  }
  const dfn = delta.function;
  if (!dfn || typeof dfn !== "object") return;
  if (!merged.function || typeof merged.function !== "object") merged.function = {};
  if (typeof dfn.name === "string" && dfn.name !== "") merged.function.name = (merged.function.name || "") + dfn.name;
  if (typeof dfn.arguments === "string" && dfn.arguments !== "") {
    merged.function.arguments = (merged.function.arguments || "") + dfn.arguments;
  }
}

export function aggregate(chunks, model) {
  let content = "";
  let reasoning = "";
  let role = "";
  let respModel = "";
  let respID = "";
  let finish = "";
  let created = 0;
  let usage = null;
  const toolCalls = new Map();
  const toolOrder = [];

  for (const text of chunks) {
    let chunk;
    try {
      chunk = JSON.parse(text);
    } catch {
      continue;
    }
    if (!chunk || typeof chunk !== "object") continue;
    if (typeof chunk.id === "string" && chunk.id !== "") respID = chunk.id;
    if (typeof chunk.model === "string" && chunk.model !== "") respModel = chunk.model;
    if (typeof chunk.created === "number") created = chunk.created;
    if (chunk.usage && typeof chunk.usage === "object") usage = chunk.usage;
    if (!Array.isArray(chunk.choices)) continue;
    for (const choice of chunk.choices) {
      if (!choice || typeof choice !== "object") continue;
      const delta = choice.delta;
      if (delta && typeof delta === "object") {
        if (typeof delta.role === "string" && delta.role !== "") role = delta.role;
        if (typeof delta.content === "string") content += delta.content;
        if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
            if (!call || typeof call !== "object") continue;
            const idx = typeof call.index === "number" ? call.index : 0;
            if (!toolCalls.has(idx)) {
              toolCalls.set(idx, { index: idx });
              toolOrder.push(idx);
            }
            mergeToolCallDelta(toolCalls.get(idx), call);
          }
        }
      }
      if (typeof choice.finish_reason === "string" && choice.finish_reason !== "") finish = choice.finish_reason;
    }
  }

  const message = { role: role || "assistant", content };
  if (reasoning !== "") message.reasoning_content = reasoning;
  if (toolOrder.length > 0) {
    toolOrder.sort((a, b) => a - b);
    message.tool_calls = toolOrder.map((idx) => toolCalls.get(idx));
  }
  const result = {
    id: respID || "chatcmpl-globalqwenwork",
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model: respModel || model,
    choices: [{ index: 0, message, finish_reason: finish || "stop" }],
  };
  if (usage) result.usage = usage;
  return result;
}

/** 单行 SSE → OpenAI chunk 文本（null = 跳过）；错误写进 state.error。 */
export function handleLine(line, state) {
  if (!line.startsWith("data:")) return null;
  const frame = unwrapFrame(line.slice(5));
  if (frame.error) {
    state.error = frame.error;
    return null;
  }
  if (!frame.ok) return null;
  try {
    const parsed = JSON.parse(frame.body);
    if (parsed && typeof parsed === "object" && parsed.usage && typeof parsed.usage === "object") state.usage = parsed.usage;
  } catch {
    /* keep raw chunk */
  }
  const cleaned = cleanChunk(frame.body);
  if (!cleaned) return null;
  return `data: ${cleaned}\n\n`;
}

export async function collectSync(upstreamBody, model) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const chunks = [];
  const state = { usage: null, error: null };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const out = handleLine(line, state);
        if (out) chunks.push(out.slice(6).trim());
      }
    }
    if (buffer) {
      const out = handleLine(buffer, state);
      if (out) chunks.push(out.slice(6).trim());
    }
  } catch (err) {
    state.error = `upstream stream read error: ${err && err.message ? err.message : err}`;
  }

  if (state.error) return { error: cleanErrorText(state.error) };
  return { completion: aggregate(chunks, model), usage: state.usage };
}

// ---- 额度耗尽识别（上游措辞表逐字搬自原作者 completions.js，含 code 14018）----
const CREDIT_EXHAUSTED_MARKERS = [
  "credits exhausted", "insufficient credit", "no credit", "credit exhausted", "out of credit",
  "quota exceeded", "quota exhaust", "credit not enough", "not enough credit", "payment required",
  "积分不足", "额度不足", "余额不足", "积分用完", "额度用尽", "没有积分",
];

export function creditsExhaustedText(value) {
  const s = String(value === undefined || value === null ? "" : value);
  if (/\bcode["'\s:=]*14018\b/.test(s)) return true;
  const lower = s.toLowerCase();
  return CREDIT_EXHAUSTED_MARKERS.some((m) => lower.includes(m.toLowerCase()));
}

export function isCreditsExhausted(status, text) {
  if (status !== 429 && status !== 402) return false;
  if (status === 402) return true;
  return creditsExhaustedText(text);
}

// globalqwenwork 变体：国际站 gateway.qwenwork.ai，协议与 cn 逐字同构（2026-10-01 现网取证），仅命名空间与常量不同 — 见 docs/adr/0041-globalqwenwork-international-provider.md
