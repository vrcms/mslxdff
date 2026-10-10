/**
 * Anthropic Messages ⇄ OpenAI chat 翻译层（/v1/messages 外壳，ADR-0047）。
 * 纯函数，无网络、无副作用；出站形状依据 code.claude.com/docs/en/llm-gateway-protocol
 * 与参考实现 lamdt1/ms-copilot365-2api/app/formatters/anthropic_sse.py。
 *
 * 与 src/responses/translate.js 的三点关键差异：
 *  1) Anthropic 的 content block **只封口不复用**（Responses 侧 ensureTextItem 会复用已开项）；
 *  2) 事件是具名的（`event: <type>` + `data:`），且**没有 `data: [DONE]`**，收场只有
 *     `message_delta`+`message_stop`（成功）或一帧 `error`（失败）——见 grill-decisions.md Q2；
 *  3) 请求侧 **必须主动丢** thinking/output_config/context_management：Claude Code 对不认识的
 *     model ID 照发全套字段，而 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` 不清 thinking 与 effort。
 */
import { chunkToString } from "../responses/translate.js";
import { isServerTool } from "./web-search.js";

let seq = 0;
export function newMessageId() {
  return `msg_${Date.now().toString(36)}${(seq++).toString(36)}`;
}
export function newToolUseId() {
  return `toolu_${Date.now().toString(36)}${(seq++).toString(36)}`;
}

/** Anthropic 协议错误体形状（非流式 JSON 与流式 in-band error 帧共用）。 */
export function anthropicError(type, message) {
  return { type: "error", error: { type: String(type || "api_error"), message: String(message || "error").slice(0, 500) } };
}

// ---------- 请求：Anthropic → chat ----------

// system 允许字符串或 text 块数组；块间空行连接（缓存语义不保留，上游是 OpenAI）
function systemTextOf(system) {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system.map((b) => (b && typeof b.text === "string" ? b.text : "")).filter(Boolean).join("\n\n");
}

function imagePartOf(block) {
  const src = block?.source || {};
  if (src.type === "base64" && src.data) {
    return { type: "image_url", image_url: { url: `data:${src.media_type || "image/png"};base64,${src.data}` } };
  }
  if (src.type === "url" && src.url) return { type: "image_url", image_url: { url: String(src.url) } };
  return null;
}

function toolResultTextOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : p && typeof p.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return content == null ? "" : String(content);
}

/** Anthropic Messages 请求体 → OpenAI chat 请求体（直接喂既有 ChatPipeline）。 */
export function messagesToChatBody(req = {}) {
  const model = String(req.model || "").trim();
  if (!model) throw new Error("messages: 缺少 model");
  const messages = [];
  const sys = systemTextOf(req.system);
  if (sys) messages.push({ role: "system", content: sys });

  // 重复 tool_use_id 保首个、丢后续：客户端重试/重放历史会把同一工具结果存两份，
  // 部分上游按 call_id 查重直接 400（同 responses/translate.js:57-59 的实测教训）。
  const seenToolResult = new Set();

  for (const m of Array.isArray(req.messages) ? req.messages : []) {
    if (!m || typeof m !== "object") continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
    let text = "";
    const imgs = [];
    const toolCalls = [];
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text") text += typeof b.text === "string" ? b.text : "";
      else if (b.type === "image") { const p = imagePartOf(b); if (p) imgs.push(p); }
      else if (b.type === "tool_use") {
        let args = "{}";
        try { args = JSON.stringify(b.input ?? {}); } catch { args = "{}"; }
        toolCalls.push({ id: String(b.id || newToolUseId()), type: "function", function: { name: String(b.name || ""), arguments: args } });
      } else if (b.type === "tool_result") {
        // tool 消息必须先于同轮 user 文本进数组：OpenAI 侧要求 role:tool 紧跟其 assistant
        const key = String(b.tool_use_id || "");
        if (key) { if (seenToolResult.has(key)) continue; seenToolResult.add(key); }
        const body = toolResultTextOf(b.content);
        messages.push({ role: "tool", tool_call_id: key, content: b.is_error ? `[tool_error] ${body}` : body });
      }
      // thinking / redacted_thinking 忽略：我们无法签发 signature，回传必被上游拒（ADR-0047）
    }
    if (!text && !imgs.length && !toolCalls.length) continue;
    const msg = { role, content: imgs.length ? [...(text ? [{ type: "text", text }] : []), ...imgs] : text };
    if (toolCalls.length) msg.tool_calls = toolCalls;
    messages.push(msg);
  }
  // 空会话直接 400：绝不伪造一句 "hi" 打上游（那会把假提问写进用户上下文并白烧一发额度）
  if (!messages.some((x) => x.role !== "system")) throw new Error("messages: 缺少用户消息");

  const body = { model, messages, stream: Boolean(req.stream) };
  // 流式必须让上游把 usage 放进收尾帧，否则 message_delta.usage 恒 0（OpenAI 规范字段）。
  // 个别上游不认 stream_options 会 400 → `MSLXDFF_ANTHROPIC_STREAM_USAGE=0` 关掉。
  if (body.stream && process.env.MSLXDFF_ANTHROPIC_STREAM_USAGE !== "0") body.stream_options = { include_usage: true };
  // Anthropic 的 server tool（web_search_*/web_fetch_*/…）没有 input_schema，折成假 function 会
  // 让上游收到「空参数空描述」的工具（严格端点直接 422），本网关不实现的发前一律剥除（ADR-0049）。
  const fnTools = (Array.isArray(req.tools) ? req.tools : []).filter((t) => !isServerTool(t));
  if (fnTools.length) {
    body.tools = fnTools.map((t) => ({
      type: "function",
      function: { name: String(t?.name || ""), description: String(t?.description || ""), parameters: t?.input_schema || {} },
    }));
  }
  const keptNames = new Set(fnTools.map((t) => String(t?.name || "")));
  const tc = req.tool_choice;
  if (tc === "auto" || (tc && typeof tc === "object" && tc.type === "auto")) body.tool_choice = "auto";
  else if (tc && typeof tc === "object" && tc.type === "any") body.tool_choice = "required";
  // 点名一个已被剥掉的工具时降为 auto：上游会按不存在的函数强制点名，那样一定拿不到有用回答
  else if (tc && typeof tc === "object" && tc.type === "tool") body.tool_choice = keptNames.has(String(tc.name || "")) ? { type: "function", function: { name: String(tc.name || "") } } : "auto";
  else if (tc && typeof tc === "object" && tc.type === "none") body.tool_choice = "none";
  if (req.max_tokens != null && Number.isFinite(Number(req.max_tokens))) body.max_tokens = Number(req.max_tokens);
  if (req.temperature != null) body.temperature = req.temperature;
  if (req.top_p != null) body.top_p = req.top_p;
  if (Array.isArray(req.stop_sequences) && req.stop_sequences.length) body.stop = req.stop_sequences;
  return body;
}

// ---------- usage / stop_reason ----------

/**
 * chat 口径 usage → Anthropic 口径。
 * Anthropic 的 `input_tokens` **不含**缓存读命中的部分（两者分开计费），而上游
 * `prompt_tokens` 是含缓存的总输入 —— 故命中数要从 input 里扣掉，否则客户端把同一段
 * 前缀算两遍（读数虚高）。
 */
export function toAnthropicUsage(u = {}) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const src = u && typeof u === "object" ? u : {};
  const prompt = num(src.prompt_tokens ?? src.input_tokens);
  const output = num(src.completion_tokens ?? src.output_tokens);
  const cacheRead = num(src.cache_read_input_tokens ?? src.prompt_tokens_details?.cached_tokens ?? src.input_tokens_details?.cached_tokens);
  const cacheWrite = num(src.cache_creation_input_tokens ?? src.prompt_tokens_details?.cache_creation_input_tokens);
  return {
    input_tokens: Math.max(0, prompt - cacheRead - cacheWrite),
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  };
}

function toStopReason(finish, hasToolUse) {
  if (hasToolUse || finish === "tool_calls" || finish === "function_call") return "tool_use";
  if (finish === "length") return "max_tokens";
  return "end_turn";
}

// ---------- 非流式响应：chat JSON → Anthropic message ----------

function parseToolInput(args) {
  const raw = String(args || "");
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : { value: v };
  } catch {
    return { raw }; // 上游吐出发散 JSON：退化成 raw，不整轮失败
  }
}

/**
 * 上游 chat 的 `message.content` 既可能是字符串，也可能是部件数组（`[{type:"text",text:…}, {type:"image_url",…}]`，
 * 多模态上游与部分聚合网关都这么回）。统一抽成正文文本；图片部件在本外壳里无法映射成 Anthropic 的 image 块，只能弃（见 ADR-0047 边界 11）。
 */
export function textFromChatContent(c) {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  let t = "";
  for (const p of c) {
    if (p && typeof p === "object" && typeof p.text === "string") t += p.text;
  }
  return t;
}

export function chatJsonToAnthropic(chatJson = {}, model = "") {
  const choice = chatJson.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];
  const text = textFromChatContent(message.content);
  if (text) content.push({ type: "text", text });
  for (const tc of message.tool_calls || []) {
    content.push({ type: "tool_use", id: String(tc.id || newToolUseId()), name: String(tc.function?.name || ""), input: parseToolInput(tc.function?.arguments) });
  }
  return {
    id: typeof chatJson.id === "string" && chatJson.id.startsWith("msg_") ? chatJson.id : newMessageId(),
    type: "message",
    role: "assistant",
    model: model || chatJson.model || "",
    content: content.length ? content : [{ type: "text", text: "" }],
    stop_reason: toStopReason(choice.finish_reason, content.some((b) => b.type === "tool_use")),
    stop_sequence: null,
    usage: toAnthropicUsage(chatJson.usage),
  };
}

// ---------- 流式响应：chat SSE chunk → Anthropic 具名事件 ----------

/**
 * @param model 回显给客户端的模型名
 * @param opts  { id?, thinking?: boolean }  thinking=true 才把 reasoning_content 发成 thinking 块
 */
export function createAnthropicChunkTranslator(model = "", opts = {}) {
  const id = opts.id || newMessageId();
  const emitThinking = opts.thinking === true;
  const created = Math.floor(Date.now() / 1000);
  const ev = (type, extra = {}) => ({ type, ...extra });

  let buf = "";
  let nextIndex = 0;
  let open = null; // 当前未封口块：{ index, kind: "text"|"thinking"|"tool_use", text? }
  const tools = new Map(); // 上游 tc.index → { id, name, args, announced, index }
  let sawToolUse = false;
  let lastFinish = null;
  let lastUsage = null;
  const dbg = { chunks: 0, textChars: 0, toolDeltas: 0, thinkingChars: 0, skippedLines: 0, jsonFails: 0, lateToolDeltas: 0, blocks: 0 };

  function closeOpen(out) {
    if (!open) return;
    out.push(ev("content_block_stop", { index: open.index }));
    open = null;
  }
  function openBlock(kind, contentBlock, out) {
    closeOpen(out);
    open = { index: nextIndex++, kind, text: "" };
    dbg.blocks = open.index + 1;
    out.push(ev("content_block_start", { index: open.index, content_block: contentBlock }));
    return open;
  }
  function pushText(delta) {
    const out = [];
    if (!open || open.kind !== "text") openBlock("text", { type: "text", text: "" }, out);
    open.text += delta;
    out.push(ev("content_block_delta", { index: open.index, delta: { type: "text_delta", text: delta } }));
    return out;
  }
  function pushThinking(delta) {
    const out = [];
    if (!open || open.kind !== "thinking") openBlock("thinking", { type: "thinking", thinking: "" }, out);
    open.text += delta;
    out.push(ev("content_block_delta", { index: open.index, delta: { type: "thinking_delta", thinking: delta } }));
    return out;
  }
  function announceTool(t, out) {
    t.announced = true;
    sawToolUse = true;
    // 统一走 openBlock：自动封掉当前 text/thinking/上一个工具块，本块成为新的待封 open
    openBlock("tool_use", { type: "tool_use", id: t.id, name: t.name, input: {} }, out);
    t.index = open.index;
    // 增量早于 id/name 到达时先攒着，announce 后补发（事件顺序仍合规）
    if (t.args) out.push(ev("content_block_delta", { index: t.index, delta: { type: "input_json_delta", partial_json: t.args } }));
  }
  function pushTool(tc) {
    const slot = Number(tc?.index ?? 0);
    const out = [];
    let t = tools.get(slot);
    if (!t) { t = { id: "", name: "", args: "", announced: false, index: null }; tools.set(slot, t); }
    if (tc?.id) t.id = String(tc.id);
    if (tc?.function?.name) t.name += String(tc.function.name);
    const frag = tc?.function?.arguments ? String(tc.function.arguments) : "";
    if (frag) { dbg.toolDeltas++; t.args += frag; }
    if (!t.announced && t.id && t.name) announceTool(t, out);
    else if (t.announced && frag && open && open.index === t.index) out.push(ev("content_block_delta", { index: t.index, delta: { type: "input_json_delta", partial_json: frag } }));
    else if (t.announced && frag) dbg.lateToolDeltas++; // 块已封口后才来的参数增量：发出即违规帧，丢弃并留读数
    return out;
  }

  function begin() {
    return [ev("message_start", { message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })];
  }

  function push(data) {
    buf += chunkToString(data);
    const out = [];
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      // 注释帧/keepalive（`:` 开头）与上游 `[DONE]` 都不进 Anthropic 事件序列（grill Q6）
      if (!line || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) { dbg.skippedLines++; continue; }
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let chunk;
      try { chunk = JSON.parse(payload); } catch { dbg.jsonFails++; continue; }
      dbg.chunks++;
      const choice = chunk.choices?.[0] || {};
      const delta = choice.delta || {};
      if (choice.finish_reason) lastFinish = choice.finish_reason;
      if (chunk.usage) lastUsage = chunk.usage;
      if (typeof delta.content === "string" && delta.content) { dbg.textChars += delta.content.length; out.push(...pushText(delta.content)); }
      for (const tc of delta.tool_calls || []) out.push(...pushTool(tc));
      const rc = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
      if (rc) {
        dbg.thinkingChars += rc.length;
        if (emitThinking) out.push(...pushThinking(rc)); // 只发 thinking_delta，无 signature 可发
      }
    }
    return out;
  }

  function end({ finish = null, usage = null } = {}) {
    const out = [];
    const fr = finish || lastFinish;
    for (const t of tools.values()) {
      if (!t.announced && (t.id || t.name || t.args)) announceTool(t, out); // 只有 arguments 无 name 的退化收尾
    }
    closeOpen(out);
    out.push(ev("message_delta", { delta: { stop_reason: toStopReason(fr, sawToolUse), stop_sequence: null }, usage: toAnthropicUsage(usage || lastUsage) }));
    out.push(ev("message_stop"));
    return out;
  }

  // 上游给聚合 JSON（非 SSE，muse-spark / workbuddy 聚合 / zcode 非流式都是这种）时，
  // 把整包喂进同一套 pushText/pushTool 状态机 —— 与流式共用封口规则，不出第二套形状。
  function fromChatJson(chatJson = {}) {
    const out = [];
    const choice = chatJson.choices?.[0] || {};
    const m = choice.message || {};
    const ct = textFromChatContent(m.content); // 字符串或部件数组都吃，别把数组正文整段丢掉
    if (ct) out.push(...pushText(ct));
    (Array.isArray(m.tool_calls) ? m.tool_calls : []).forEach((tc, i) => {
      out.push(...pushTool({ index: i, id: tc?.id, function: { name: tc?.function?.name, arguments: tc?.function?.arguments } }));
    });
    if (choice.finish_reason) lastFinish = choice.finish_reason;
    if (chatJson.usage) lastUsage = chatJson.usage;
    return out;
  }

  function getFinal() {
    return { finish: lastFinish, usage: lastUsage, sawToolUse };
  }
  function stats() {
    return { ...dbg, openKind: open?.kind || null, toolSlots: tools.size };
  }

  return { id, created, begin, push, end, fromChatJson, getFinal, stats };
}

// ---------- count_tokens 字符估算 ----------

// 图片不吃字符但占真实上下文，按固定面值计；总长设硬上限防极端请求把除法推到 Infinity
const IMAGE_TOKENS = 2000;
const CHARS_PER_TOKEN = 4;
const CHAR_CAP = 32_000_000;

function countMessage(m, acc) {
  if (!m || typeof m !== "object") return;
  const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : null;
  if (!blocks) { acc.chars += JSON.stringify(m.content ?? "").length; return; }
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (typeof b.text === "string") acc.chars += b.text.length;
    else if (b.type === "tool_use") acc.chars += String(b.name || "").length + JSON.stringify(b.input ?? {}).length;
    else if (b.type === "tool_result") acc.chars += toolResultTextOf(b.content).length; // 工具结果是大头，必须算（grill Q7）
    else if (b.type === "thinking") acc.chars += String(b.thinking || "").length;
    else if (b.type === "image") acc.images += 1;
  }
}

/** 字符估算版 token 计数（Anthropic 官方：端点缺失时客户端本来就退回字符估算，精度非目标）。 */
export function estimateTokens(req = {}) {
  let chars = 0;
  let images = 0;
  const acc = { chars: 0, images: 0 };
  const sys = typeof req.system === "string" ? [{ type: "text", text: req.system }] : Array.isArray(req.system) ? req.system : [];
  for (const b of sys) acc.chars += b && typeof b.text === "string" ? b.text.length : 0;
  for (const m of Array.isArray(req.messages) ? req.messages : []) countMessage(m, acc);
  if (Array.isArray(req.tools)) acc.chars += JSON.stringify(req.tools).length;
  chars = Math.min(acc.chars, CHAR_CAP);
  images = acc.images;
  // 字段名以 Anthropic 线上为准：`POST /v1/messages/count_tokens` 回 `{"input_tokens": N}`；
  // 额外带一份 count_tokens 仅作人读兼容（Claude Code 读的是 input_tokens）。
  const n = Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS);
  return { input_tokens: n, count_tokens: n };
}
