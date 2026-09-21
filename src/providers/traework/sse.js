// SOLO 自定义 SSE 解析 → OpenAI SSE（流式转换 + 非流式聚合）。
// 照抄 traework2api internal/upstream/solosse.go。纯函数，可测。
import { SOLOStreamError } from "./errors.js";

// 解析一条事件（eventName 为 event 行值，dataLine 为 data 行值）。
export function parseSOLOLine(eventName, dataLine) {
  const ev = { event: String(eventName || "").trim(), response: "", reasoning: "", toolCalls: null, usage: null, finishReason: "", errorCode: 0, errorMessage: "" };
  if (!dataLine) return ev;
  let raw;
  try { raw = JSON.parse(dataLine); } catch { throw new Error("solo sse data parse error"); }
  if (!raw || typeof raw !== "object") return ev;
  if (ev.event === "output") {
    if (typeof raw.response === "string") ev.response = raw.response;
    if (typeof raw.reasoning_content === "string") ev.reasoning = raw.reasoning_content;
    if ("tool_calls" in raw && raw.tool_calls != null) ev.toolCalls = raw.tool_calls;
  } else if (ev.event === "token_usage") {
    ev.usage = raw;
  } else if (ev.event === "done") {
    if (typeof raw.finish_reason === "string") ev.finishReason = raw.finish_reason;
  } else if (ev.event === "error") {
    if (typeof raw.code === "number") ev.errorCode = raw.code;
    else if (typeof raw.code === "string" && raw.code.trim() !== "" && Number.isFinite(Number(raw.code))) ev.errorCode = Number(raw.code);
    if (typeof raw.message === "string") ev.errorMessage = raw.message;
  }
  return ev;
}

// sseState 维护一行 SSE 的 event/data 跨行累积。
export function createSseState() { return { event: "", data: "" }; }
export function resetSseState(st) { st.event = ""; st.data = ""; }

// scanLine 处理一行；返回该行触发的事件（事件边界时解析并返回）。
export function scanLine(st, line) {
  const s = String(line ?? "");
  if (s === "") {
    if (!st.event) { resetSseState(st); return null; }
    let ev = null;
    try { ev = parseSOLOLine(st.event, st.data); } catch { ev = null; }
    resetSseState(st);
    return ev;
  }
  if (s.startsWith("event:")) st.event = s.slice("event:".length).trim();
  else if (s.startsWith("data:")) st.data += s.slice("data:".length);
  else if (s.startsWith(":")) { /* 注释行忽略 */ }
  return null;
}

function mergeToolCallDelta(merged, delta) {
  if (typeof delta?.id === "string" && delta.id) merged.id = delta.id;
  if (typeof delta?.type === "string" && delta.type) merged.type = delta.type;
  let df = delta?.function && typeof delta.function === "object" ? { ...delta.function } : null;
  if (!df && delta?.function_call && typeof delta.function_call === "object") df = { ...delta.function_call };
  if (!df) return;
  delete df.namespace;
  delete df.partial_arguments;
  if (!merged.function || typeof merged.function !== "object") merged.function = {};
  if (typeof df.name === "string" && df.name) merged.function.name = df.name;
  if (typeof df.arguments === "string" && df.arguments) {
    merged.function.arguments = (typeof merged.function.arguments === "string" ? merged.function.arguments : "") + df.arguments;
  }
}

function mergeToolCallJSON(toolCalls, toolOrder, raw) {
  if (raw == null) return;
  let arr;
  if (Array.isArray(raw)) arr = raw;
  else if (raw && typeof raw === "object") arr = [raw];
  else return;
  for (const call of arr) {
    if (!call || typeof call !== "object") continue;
    const idx = Number.isFinite(Number(call.index)) ? Number(call.index) : 0;
    if (!Object.prototype.hasOwnProperty.call(toolCalls, idx)) {
      toolCalls[idx] = { index: idx };
      toolOrder.push(idx);
    }
    mergeToolCallDelta(toolCalls[idx], call);
  }
}

// 把 SOLO tool_call 条目 function_call → function（流式 delta 用）。
export function normalizeStreamToolCalls(raw) {
  const arr = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const call = { ...item };
    if (call.function_call && typeof call.function_call === "object") {
      call.function = call.function_call;
      delete call.function_call;
    }
    if (call.function && typeof call.function === "object") {
      call.function = { ...call.function };
      delete call.function.namespace;
      delete call.function.partial_arguments;
    }
    out.push(call);
  }
  return out;
}

function openAIChunk(id, created, model, delta, finish, usage) {
  const chunk = { id, object: "chat.completion.chunk", created, model: model || "", choices: [{ index: 0, delta }] };
  if (finish) chunk.choices[0].finish_reason = finish;
  if (usage) chunk.usage = usage;
  return chunk;
}

// convertToOpenAIChunks：SOLO SSE 文本 → OpenAI SSE 文本（每 chunk flush 语义由调用方保证至少一个 [DONE]）。
export function convertToOpenAIChunks(soloText, { model = "", chatId = "", created = 0 } = {}) {
  const id = chatId || `chatcmpl-${Date.now()}`;
  const ts = created || Math.floor(Date.now() / 1000);
  const st = createSseState();
  const frames = [];
  let pendingUsage = null;
  let sawDone = false;
  const push = (delta, finish) => frames.push(`data: ${JSON.stringify(openAIChunk(id, ts, model, delta, finish, pendingUsage || undefined))}\n\n`) || (pendingUsage = null);
  for (const line of String(soloText || "").split("\n")) {
    const ev = scanLine(st, line.replace(/\r$/, ""));
    if (!ev) continue;
    if (ev.event === "output") {
      const delta = {};
      if (ev.response) delta.content = ev.response;
      if (ev.reasoning) delta.reasoning_content = ev.reasoning;
      if (ev.toolCalls != null) delta.tool_calls = normalizeStreamToolCalls(ev.toolCalls);
      if (Object.keys(delta).length) push(delta, "");
    } else if (ev.event === "token_usage") pendingUsage = ev.usage;
    else if (ev.event === "done") { push({}, ev.finishReason || "stop"); frames.push("data: [DONE]\n\n"); sawDone = true; }
    else if (ev.event === "error") {
      const se = new SOLOStreamError(ev.errorCode, ev.errorMessage);
      frames.push(`event: error\ndata: ${JSON.stringify(se.message)}\n\n`);
      frames.push("data: [DONE]\n\n");
      sawDone = true;
    }
  }
  if (!sawDone) frames.push("data: [DONE]\n\n");
  return frames.join("");
}

// aggregateToCompletion：完整 SOLO SSE 文本 → 单个 OpenAI chat.completion（非流式）。
export function aggregateToCompletion(soloText, { model = "", chatId = "", created = 0 } = {}) {
  const st = createSseState();
  let content = "";
  let reasoning = "";
  let finishReason = "stop";
  let usage = null;
  const toolCalls = {};
  const toolOrder = [];
  for (const line of String(soloText || "").split("\n")) {
    const ev = scanLine(st, line.replace(/\r$/, ""));
    if (!ev) continue;
    if (ev.event === "output") {
      content += ev.response || "";
      reasoning += ev.reasoning || "";
      mergeToolCallJSON(toolCalls, toolOrder, ev.toolCalls);
    } else if (ev.event === "token_usage") usage = ev.usage;
    else if (ev.event === "done") { if (ev.finishReason) finishReason = ev.finishReason; }
    else if (ev.event === "error") throw new SOLOStreamError(ev.errorCode, ev.errorMessage);
  }
  const message = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolOrder.length) message.tool_calls = [...toolOrder].sort((a, b) => a - b).map((i) => toolCalls[i]);
  const resp = {
    id: chatId || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model: model || "",
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
  if (usage) resp.usage = usage;
  return resp;
}

// aggregateStreamReader：ReadableStream（fetch Response.body）→ chat.completion（流式 Response 转非流式用）。
export async function aggregateStreamReader(stream, opts = {}) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) text += dec.decode(value, { stream: !done });
    if (done) break;
  }
  return aggregateToCompletion(text, opts);
}
