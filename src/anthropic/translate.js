/**
 * Anthropic Messages 出站翻译层：chat → Anthropic message / SSE 具名事件（/v1/messages 外壳，ADR-0047）。
 * 纯函数，无网络、无副作用；出站形状依据 code.claude.com/docs/en/llm-gateway-protocol
 * 与参考实现 lamdt1/ms-copilot365-2api/app/formatters/anthropic_sse.py。
 * 分档（ADR-0055，为守本文件 ≤20KB 体积硬门；对外 import 路径全走本文件、调用方零改动）：
 *  · 请求侧 Anthropic → chat 在 ./request-body.js；
 *  · 消息/工具 id 与协议错误体在 ./shared.js；
 *  · token 估算的单一来源在 ../text-tokens.js（上游未报 usage 时由它兜底）。
 *
 * 与 src/responses/translate.js 的三点关键差异：
 *  1) Anthropic 的 content block **只封口不复用**（Responses 侧 ensureTextItem 会复用已开项）；
 *  2) 事件是具名的（`event: <type>` + `data:`），且**没有 `data: [DONE]`**，收场只有
 *     `message_delta`+`message_stop`（成功）或一帧 `error`（失败）——见 grill-decisions.md Q2；
 *  3) 请求侧**保留思考档位**、**必须主动丢** output_config/context_management 与消息块内 thinking
 *     （块内 thinking 我们无法签发 signature，回传必被上游拒）——细则见 ./request-body.js 头（ADR-0047）。
 */
import { chunkToString } from "../responses/translate.js";
import { createTokenCounter } from "../text-tokens.js";
import { newMessageId, newToolUseId } from "./shared.js";

// re-export：拆档不改对外接口，调用方与测试仍从本文件取这些符号
export { messagesToChatBody, toolResultTextOf } from "./request-body.js";
export { newMessageId, newToolUseId, anthropicError } from "./shared.js";

// ---------- usage / stop_reason ----------

/**
 * chat 口径 usage → Anthropic 口径。
 * Anthropic 的 `input_tokens` **不含**缓存读命中的部分（两者分开计费），而上游
 * `prompt_tokens` 是含缓存的总输入 —— 故命中数要从 input 里扣掉，否则客户端把同一段
 * 前缀算两遍（读数虚高）。
 * `fallback()` 只在**上游整条未报**（缺字段，或 prompt/output/cache_read/cache_creation 四项全为 0）时才用：
 * 真实模型对非空 prompt 不可能报 0，照抄 0 会让客户端的上下文计度停在原地、永不压实（ADR-0055 决策 3）。
 */
export function toAnthropicUsage(u = {}, fallback = null) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const src = u && typeof u === "object" ? u : {};
  const prompt = num(src.prompt_tokens ?? src.input_tokens);
  const output = num(src.completion_tokens ?? src.output_tokens);
  const cacheRead = num(src.cache_read_input_tokens ?? src.prompt_tokens_details?.cached_tokens ?? src.input_tokens_details?.cached_tokens);
  const cacheWrite = num(src.cache_creation_input_tokens ?? src.prompt_tokens_details?.cache_creation_input_tokens);
  const usage = {
    input_tokens: Math.max(0, prompt - cacheRead - cacheWrite),
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  };
  // cache 非零也算「报了」：SDK 通道（upstream-engine/sdk/sse.js 的 usageToOpenAI）会输出
  // `{prompt_tokens:0, …, prompt_tokens_details:{cached_tokens:N}}` 这种形状，若当未报整条覆盖，
  // 客户端「input + cache_read」会把同一段前缀算两遍（正是上面扣减要防的事，评审 P2）。
  if (fallback && !(prompt > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0)) return { ...usage, ...(fallback() || {}) };
  return usage;
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

export function chatJsonToAnthropic(chatJson = {}, model = "", opts = {}) {
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
    usage: toAnthropicUsage(chatJson.usage, () => fallbackUsage(opts, content)),
  };
}

// 上游整条未报 usage 时的兜底（ADR-0055 决策 3）：请求侧用注入的 estInput，生成侧按已产出的块估。
function fallbackUsage(opts = {}, content = []) {
  const counter = createTokenCounter();
  for (const b of content) {
    if (b?.type === "text") counter.add(b.text || "");
    else if (b?.type === "tool_use") counter.add(JSON.stringify(b.input ?? {})); // 只计参数：与流式 pushTool 同口径（name 从不进 gen）
  }
  const n = typeof opts.estInput === "function" ? Number(opts.estInput()) : 0;
  return { input_tokens: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0, output_tokens: counter.tokens() };
}

// ---------- 流式响应：chat SSE chunk → Anthropic 具名事件 ----------

// thinking 块必须在 content_block_stop **之前**交一帧 signature_delta，缺它 Claude Code 把整块静默丢弃
// （routatic/proxy#51 真机复现、PR#133 修）。下面是**身份占位**：不含思考原文、不冒充密码学签名，理由与风险见 ADR-0052。
const SIG_PREFIX = "mslxdff:thinking:v1:";
function thinkingSignature(messageId, index) {
  return Buffer.from(`${SIG_PREFIX}${messageId}:${index}`, "utf8").toString("base64url");
}

/**
 * @param model 回显给客户端的模型名
 * @param opts  { id?, thinking?: boolean }  thinking=true 才把 reasoning_content 发成 thinking 块
 */
export function createAnthropicChunkTranslator(model = "", opts = {}) {
  const id = opts.id || newMessageId();
  const emitThinking = opts.thinking === true;
  const created = Math.floor(Date.now() / 1000);
  const ev = (type, extra = {}) => ({ type, ...extra });

  // 请求侧 token 估算（ADR-0055 决策 3/5）：路由注入 `opts.estInput()`，memoize —— `message_start` 必须在
  // 首块前就带 input_tokens，全文只能扫一遍；上游后报实测 usage 时估算只留在首帧，不进 message_delta。
  let estCached = null;
  const estInput = () => {
    if (estCached == null) {
      const n = typeof opts.estInput === "function" ? Number(opts.estInput()) : 0;
      estCached = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    }
    return estCached;
  };
  const gen = createTokenCounter(); // 生成侧累计（text + thinking + tool 参数增量）

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
    if (open.kind === "thinking") out.push(ev("content_block_delta", { index: open.index, delta: { type: "signature_delta", signature: thinkingSignature(id, open.index) } }));
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
    gen.add(delta); // 生成侧只累计字数、末帧一次套公式：逐帧套会把参照实现的 +1 下限乘上帧数
    out.push(ev("content_block_delta", { index: open.index, delta: { type: "text_delta", text: delta } }));
    return out;
  }
  function pushThinking(delta) {
    const out = [];
    if (!open || open.kind !== "thinking") openBlock("thinking", { type: "thinking", thinking: "", signature: "" }, out);
    open.text += delta;
    gen.add(delta); // thinking 也按 output 计费（ADR-0055 grill Q6）
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
    if (frag) { dbg.toolDeltas++; t.args += frag; gen.add(frag); }
    if (!t.announced && t.id && t.name) announceTool(t, out);
    else if (t.announced && frag && open && open.index === t.index) out.push(ev("content_block_delta", { index: t.index, delta: { type: "input_json_delta", partial_json: frag } }));
    else if (t.announced && frag) dbg.lateToolDeltas++; // 块已封口后才来的参数增量：发出即违规帧，丢弃但上面已计入 gen（output_tokens 取计费口径：模型确实生成了这些字节）
    return out;
  }

  function begin() {
    return [ev("message_start", { message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: estInput(), output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })];
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
        else gen.add(rc); // `MSLXDFF_ANTHROPIC_THINKING=0` 时思考字节仍是真实生成，兜底 output 照计（在此加、不在 pushThinking 内加，避免双计）
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
    out.push(ev("message_delta", { delta: { stop_reason: toStopReason(fr, sawToolUse), stop_sequence: null }, usage: toAnthropicUsage(usage || lastUsage, () => ({ input_tokens: estInput(), output_tokens: gen.tokens() })) }));
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
    // 聚合上游把思考放在 message.reasoning_content（muse-spark / workbuddy 聚合 / zcode 非流式）：thinking 块须排 text 前。
    const rt = typeof m.reasoning_content === "string" ? m.reasoning_content : "";
    if (rt && emitThinking) out.push(...pushThinking(rt));
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
