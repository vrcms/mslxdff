/**
 * Responses ⇄ Chat 翻译层（给 Codex/ChatGPT 桌面端用的 /v1/responses 端点）。
 * 纯函数，无网络、无副作用。无状态：previous_response_id 不支持（stateless 网关）。
 */
let seq = 0;
export function newResponseId() {
  return `resp_${Date.now().toString(36)}${(seq++).toString(36)}`;
}

// 上游块可能是 Buffer/Uint8Array：String() 会变成 "100,97,..." 数字串，必须解码
const _decoder = new TextDecoder();
export function chunkToString(c) {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(c)) return c.toString("utf8");
  if (c instanceof Uint8Array) return _decoder.decode(c);
  return String(c);
}

function inputTextOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((p) => p && (p.type === "input_text" || p.type === "text")).map((p) => p.text || "").join("");
  }
  return String(content ?? "");
}

// POST /v1/responses body → chat completions body（直接喂现有 pipeline）
export function responsesToChatBody(req = {}) {
  const model = String(req.model || "").trim();
  if (!model) throw new Error("responses: 缺少 model");
  const messages = [];
  if (req.instructions) messages.push({ role: "system", content: String(req.instructions) });
  const input = req.input;
  const items = typeof input === "string" ? [{ type: "message", role: "user", content: input }] : Array.isArray(input) ? input : [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    if (it.type === "message") {
      messages.push({ role: it.role || "user", content: inputTextOf(it.content) });
    } else if (it.type === "function_call") {
      messages.push({
        role: "assistant", content: "",
        tool_calls: [{ id: it.call_id || it.id || "", type: "function", function: { name: it.name || "", arguments: it.arguments || "" } }],
      });
    } else if (it.type === "function_call_output") {
      messages.push({ role: "tool", tool_call_id: it.call_id || "", content: typeof it.output === "string" ? it.output : JSON.stringify(it.output ?? "") });
    }
  }
  if (!messages.length) messages.push({ role: "user", content: "hi" });
  const body = { model, messages, stream: Boolean(req.stream) };
  if (Array.isArray(req.tools) && req.tools.length) {
    body.tools = req.tools.map((t) => (t?.type === "function"
      ? { type: "function", function: { name: t.name, description: t.description || "", parameters: t.parameters || {} } }
      : t));
  }
  if (req.tool_choice) {
    const tc = req.tool_choice;
    body.tool_choice = tc?.type === "function" ? { type: "function", function: { name: tc.name } } : tc;
  }
  if (req.max_output_tokens != null) body.max_tokens = Number(req.max_output_tokens);
  if (req.temperature != null) body.temperature = req.temperature;
  if (req.top_p != null) body.top_p = req.top_p;
  if (req.parallel_tool_calls != null) body.parallel_tool_calls = req.parallel_tool_calls;
  return body;
}

// chat 口径 usage → Responses 口径（codex 解 ResponseCompleted 硬要 input_tokens/output_tokens，缺则整轮作废）
export function toResponsesUsage(u = {}) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const src = u && typeof u === "object" ? u : {};
  const pt = num(src.prompt_tokens ?? src.input_tokens);
  const ct = num(src.completion_tokens ?? src.output_tokens);
  return {
    input_tokens: pt,
    input_tokens_details: { cached_tokens: num(src.input_tokens_details?.cached_tokens ?? src.prompt_tokens_details?.cached_tokens) },
    output_tokens: ct,
    output_tokens_details: { reasoning_tokens: num(src.output_tokens_details?.reasoning_tokens ?? src.completion_tokens_details?.reasoning_tokens) },
    total_tokens: num(src.total_tokens ?? pt + ct),
  };
}

function messageToOutputItems(message = {}) {
  const out = [];
  const text = typeof message.content === "string" ? message.content : "";
  if (text) {
    out.push({ type: "message", id: `msg_${newResponseId()}`, status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
  }
  for (const tc of message.tool_calls || []) {
    out.push({ type: "function_call", id: `fc_${newResponseId()}`, call_id: tc.id || "", name: tc.function?.name || "", arguments: tc.function?.arguments || "", status: "completed" });
  }
  return out;
}

// chat JSON → Response 对象（非流式）
export function chatJsonToResponse(chatJson = {}, model = "") {
  const choice = chatJson.choices?.[0] || {};
  const output = messageToOutputItems(choice.message || {});
  return {
    id: chatJson.id && String(chatJson.id).startsWith("resp_") ? chatJson.id : newResponseId(),
    object: "response",
    created_at: chatJson.created || Math.floor(Date.now() / 1000),
    status: choice.finish_reason === "length" ? "incomplete" : "completed",
    model: model || chatJson.model || "",
    output,
    usage: toResponsesUsage(chatJson.usage),
  };
}

// chat SSE chunk 流 → responses SSE 事件流（逐块翻译，tool_calls 按 index 累积）
export function createChunkTranslator(model = "") {
  const id = newResponseId();
  const createdAt = Math.floor(Date.now() / 1000);
  let buf = "";
  let textItemOpen = false;
  let textLen = 0;
  let lastFinish = "stop";
  let lastUsage = null;
  const tools = new Map(); // index → {id, name, args, announced}
  const ev = (type, extra = {}) => ({ type, ...extra });

  function begin() {
    return [ev("response.created", { response: { id, object: "response", created_at: createdAt, status: "in_progress", model, output: [] } })];
  }

  function ensureTextItem() {
    if (textItemOpen) return [];
    textItemOpen = true;
    const item = { type: "message", id: `msg_${id}`, status: "in_progress", role: "assistant", content: [{ type: "output_text", text: "", annotations: [] }] };
    return [ev("response.output_item.added", { output_index: 0, item }), ev("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } })];
  }

  let fullText = "";
  function pushText(delta) {
    if (!delta) return [];
    const out = ensureTextItem();
    textLen += delta.length;
    fullText += delta;
    out.push(ev("response.output_text.delta", { item_id: `msg_${id}`, output_index: 0, content_index: 0, delta }));
    return out;
  }

  function pushTool(tc) {
    const idx = Number(tc.index ?? 0);
    let t = tools.get(idx);
    if (!t) { t = { id: "", name: "", args: "", announced: false }; tools.set(idx, t); }
    if (tc.id) t.id = tc.id;
    if (tc.function?.name) t.name += tc.function.name;
    const frag = tc.function?.arguments || "";
    const out = [];
    if (!t.announced && t.id && t.name) {
      t.announced = true;
      out.push(ev("response.output_item.added", { output_index: idx + 1, item: { type: "function_call", id: `fc_${id}_${idx}`, call_id: t.id, name: t.name, arguments: "" } }));
    }
    if (frag) {
      if (!t.announced) { t.args += frag; return out; } // id/name 未到先攒着
      t.args += frag;
      out.push(ev("response.function_call_arguments.delta", { item_id: `fc_${id}_${idx}`, output_index: idx + 1, delta: frag }));
    }
    return out;
  }

  const dbg = { chunks: 0, textChars: 0, toolDeltas: 0, skippedLines: 0, jsonFails: 0, reasoningChars: 0 };
  function push(data) {
    buf += chunkToString(data);
    const out = [];
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) { dbg.skippedLines++; continue; }
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      let chunk;
      try { chunk = JSON.parse(payload); } catch { dbg.jsonFails++; continue; }
      dbg.chunks++;
      const delta = chunk.choices?.[0]?.delta || {};
      const fr = chunk.choices?.[0]?.finish_reason;
      if (fr) lastFinish = fr;
      if (chunk.usage) lastUsage = chunk.usage;
      if (typeof delta.content === "string" && delta.content) { dbg.textChars += delta.content.length; out.push(...pushText(delta.content)); }
      for (const tc of delta.tool_calls || []) { dbg.toolDeltas++; out.push(...pushTool(tc)); }
      const rc = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
      if (rc) { dbg.reasoningChars += rc.length; out.push(...pushText(rc)); }
    }
    return out;
  }

  function end({ finish = "stop", usage = null } = {}) {
    const out = [];
    if (textItemOpen) {
      out.push(ev("response.output_text.done", { item_id: `msg_${id}`, output_index: 0, content_index: 0, text: fullText }));
      out.push(ev("response.content_part.done", { item_id: `msg_${id}`, output_index: 0, content_index: 0, part: { type: "output_text", text: fullText, annotations: [] } }));
      out.push(ev("response.output_item.done", { output_index: 0, item: { type: "message", id: `msg_${id}`, status: "completed", role: "assistant", content: [{ type: "output_text", text: fullText, annotations: [] }] } }));
    }
    let i = 0;
    for (const [idx, t] of tools) {
      if (!t.id && !t.name && !t.args) { i++; continue; }
      if (!t.announced) {
        out.push(ev("response.output_item.added", { output_index: idx + 1, item: { type: "function_call", id: `fc_${id}_${idx}`, call_id: t.id, name: t.name, arguments: "" } }));
      }
      if (t.args) out.push(ev("response.function_call_arguments.done", { item_id: `fc_${id}_${idx}`, output_index: idx + 1, arguments: t.args }));
      out.push(ev("response.output_item.done", { output_index: idx + 1, item: { type: "function_call", id: `fc_${id}_${idx}`, call_id: t.id, name: t.name, arguments: t.args, status: "completed" } }));
      i++;
    }
    void i; void textLen;
    out.push(ev("response.completed", { response: { id, object: "response", created_at: createdAt, status: finish === "length" ? "incomplete" : "completed", model, output: [], usage: toResponsesUsage(usage) } }));
    return out;
  }

  function getFinal() {
    return { finish: lastFinish, usage: lastUsage };
  }

  function stats() {
    return { ...dbg, outEvents: null, textItemOpen, toolCalls: tools.size };
  }

  return { id, begin, push, end, getFinal, stats };
}
