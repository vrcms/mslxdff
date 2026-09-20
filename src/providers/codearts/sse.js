// CodeArts SSE 帧解析（纯函数，无 IO）。
// 线格式（实测，对齐 codearts2api internal/upstream/sse.go）：逐行 `data: <json>`，
// 无空行分隔、部分行无 event: 前缀；同时兼容标准 event:+data:+空行。
// 帧：起始 {id,model,type:"answer",chat_id,…}；全文快照 {text:"<累计全文>",output,
// prompt_tokens,completion_tokens}（text 是快照非增量 → 替换语义）；增量
// {choices:[{delta:{content,reasoning_content,tool_calls}}]} 或顶层 {delta:{…}}；
// 结束 {"text":"[DONE]","error_code":"0"}；错误 {"error_code":"…","error_msg":"…"}。

export function createSseState() {
  return { pendingEvent: "", content: "", reason: "", finish: "", usage: null, error: null, done: false, calls: new Map() };
}

// event: → 暂存不触发；data: → 立即触发并清空暂存；空行只清暂存；: 注释；其余忽略。
export function scanLine(line, state) {
  const raw = String(line || "").replace(/\r?\n$/, "");
  if (raw.startsWith("event:")) { state.pendingEvent = raw.slice(6).trim(); return null; }
  if (raw.startsWith("data:")) {
    const ev = state.pendingEvent || "";
    state.pendingEvent = "";
    return { event: ev, data: raw.slice(5).trim() };
  }
  if (!raw.trim()) { state.pendingEvent = ""; return null; }
  return null;
}

// OpenAI 兼容 chunk：choices[0].delta 或顶层 delta。
export function deltaFromChunk(payload) {
  if (payload?.delta && typeof payload.delta === "object") return { delta: payload.delta, finishReason: "" };
  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  if (!choices.length || typeof choices[0] !== "object") return { delta: null, finishReason: "" };
  const c0 = choices[0];
  return {
    delta: c0.delta && typeof c0.delta === "object" ? c0.delta : null,
    finishReason: typeof c0.finish_reason === "string" ? c0.finish_reason : "",
  };
}

// tool_calls 分片按 index 聚合（id/type/name/arguments 增量拼接）。
export function applyToolCallDeltas(st, delta) {
  const rawCalls = delta?.tool_calls;
  if (!Array.isArray(rawCalls)) return;
  rawCalls.forEach((raw, position) => {
    if (!raw || typeof raw !== "object") return;
    const index = typeof raw.index === "number" ? raw.index : position;
    let call = st.calls.get(index);
    if (!call) { call = { index, type: "function", id: "", function: { name: "", arguments: "" } }; st.calls.set(index, call); }
    if (typeof raw.id === "string" && raw.id) call.id = raw.id;
    if (typeof raw.type === "string" && raw.type) call.type = raw.type;
    const fn = raw.function;
    if (fn && typeof fn === "object") {
      if (typeof fn.name === "string") call.function.name += fn.name;
      if (typeof fn.arguments === "string") call.function.arguments += fn.arguments;
    }
  });
}

export function sortedToolCalls(st) {
  return [...st.calls.keys()].sort((a, b) => a - b).map((i) => {
    const c = st.calls.get(i);
    return { index: c.index, type: c.type || "function", id: c.id, function: { name: c.function.name, arguments: c.function.arguments } };
  });
}

const firstText = (payload, keys) => {
  for (const k of keys) if (typeof payload?.[k] === "string") return payload[k];
  return "";
};

function markUsage(st, payload) {
  const p = Number(payload?.prompt_tokens), c = Number(payload?.completion_tokens);
  if (Number.isFinite(p) || Number.isFinite(c)) {
    st.usage = {
      prompt_tokens: Number.isFinite(p) ? p : (st.usage?.prompt_tokens || 0),
      completion_tokens: Number.isFinite(c) ? c : (st.usage?.completion_tokens || 0),
    };
  }
}

function tryStructuredAnswer(st, payload) {
  if (st.content || typeof payload?.answer !== "string" || !payload.answer) return;
  if (payload.question !== undefined || payload.options !== undefined) st.content = payload.answer;
}

// 单事件应用到聚合状态（对齐 Go applyEvent 的替换/追加语义）。
export function applyEvent(st, event, data) {
  const ev = String(event || "").trim().toLowerCase();
  const trimmed = String(data || "").trim();
  if (ev === "" && trimmed === "[DONE]") { if (!st.finish) st.finish = "stop"; st.done = true; return; }
  let payload = null;
  if (trimmed && trimmed !== "[DONE]") { try { payload = JSON.parse(trimmed); } catch { payload = null; } }

  const checkError = () => {
    const code = firstText(payload || {}, ["error_code", "code"]);
    if (code && code !== "0") {
      st.error = { code, msg: firstText(payload || {}, ["error_msg", "message", "msg"]) || "request failed" };
      return true;
    }
    return false;
  };
  const applyDeltaLike = (textKeys) => {
    if (checkError()) return true;
    const { delta, finishReason } = deltaFromChunk(payload);
    if (finishReason) st.finish = finishReason;
    if (delta) {
      applyToolCallDeltas(st, delta);
      if (typeof delta.content === "string" && delta.content) st.content += delta.content;
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) st.reason += delta.reasoning_content;
      return true;
    }
    markUsage(st, payload);
    const t = firstText(payload || {}, textKeys);
    if (t) {
      if (trimmed === "[DONE]" || t === "[DONE]" || /^done$/i.test(t)) { st.finish = "stop"; st.done = true; return true; }
      st.content = t; // 全文快照 → 替换
      return true;
    }
    const out = Array.isArray(payload?.output) ? payload.output : null;
    if (out && out.length) {
      const sb = out.filter((x) => x?.type === "output_text" && typeof x.text === "string").map((x) => x.text).join("");
      if (sb) st.content = sb;
      return true;
    }
    tryStructuredAnswer(st, payload || {});
    return true;
  };

  switch (ev) {
    case "reasoning": case "thinking": case "onreasoning": case "onthinking": {
      const t = firstText(payload || {}, ["text", "reasoning", "content", "thinking"]);
      if (t) st.reason += t;
      return;
    }
    case "done": case "end": case "finish": {
      if (checkError()) return;
      const f = firstText(payload || {}, ["finish_reason", "finish", "reason"]);
      st.finish = f || "stop";
      st.done = true;
      return;
    }
    case "onanswer": case "answer": case "delta": case "message": case "content": case "": case "data": {
      if (trimmed === "[DONE]") { if (!st.finish) st.finish = "stop"; st.done = true; return; }
      applyDeltaLike(ev === "" || ev === "data" ? ["text", "content", "delta"] : ["text", "content", "delta", "message"]);
      return;
    }
    default: return; // related_question_answer 等杂帧忽略
  }
}

// HTTP 200 内嵌错误 → 状态映射（429/400/502），让网关按状态码走冷却/降级。
export function embeddedErrorFromData(data) {
  const trimmed = String(data || "").trim();
  if (!trimmed || trimmed === "[DONE]") return null;
  let payload;
  try { payload = JSON.parse(trimmed); } catch { return null; }
  const code = typeof payload?.error_code === "string" ? payload.error_code : "";
  if (!code || code === "0") return null;
  const message = typeof payload?.error_msg === "string" ? payload.error_msg : "";
  const combined = `${code} ${message}`.trim();
  const low = combined.toLowerCase();
  let status = 502;
  if (/429|tm\.00001041|tpm|并发会话/.test(low)) status = 429;
  else if (/002002009|not registered|4004\.200|benefit not found/.test(low)) status = 400;
  return { status, message: combined.slice(0, 300) };
}

export class UpstreamEventError extends Error {
  constructor(message, { status = 502, code = "" } = {}) {
    super(message);
    this.name = "UpstreamEventError";
    this.status = status;
    this.code = code;
  }
}
