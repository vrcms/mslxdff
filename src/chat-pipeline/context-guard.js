// 转发前上下文预检：本地额度用完要转给组员时，先把「上下文会不会撑爆对方」判掉。
//
// 为什么需要（用户定的口径）：各家 free 模型的上下文窗口各不相同、大多在 200k 以下，而网关**没有**
// 一个可靠的上游窗口数据源 —— 靠模型自报会拿到 1M 这类不实的值（见 context-lookup 的 L4 兜底）。
// 于是本地出口还有额度时一切正常（本地模型窗口往往更大），一旦额度用完转给组员，同一份大上下文
// 在对方那里直接 `400 context_length_exceeded`。现网实证：errors.log 里 376 条超限，其中 274 条
// 来自 broadband（组员执行）、93 条来自 messages、仅 9 条 chat；模型集中在 deepseek-v4.1-flash-free(323)。
//
// 设计取舍：**不猜每个模型的确切窗口**，只设一个保守的统一上限（默认 200k）。超了就**不转发**，
// 让客户端按标准 `context_length_exceeded` 触发自己的压缩流程 —— 这正是「在转发之前触发压缩」。
// 宁可让客户端多压一次，也不要把一个大上下文白转给组员、烧掉对方额度再撞墙。
//
// 与 count-tokens 的关系：估算公式**同源**（../text-tokens.js），不另造第二个读数来源（ADR-0055）。
// 但计量对象不同：那边是 Anthropic 请求体（system/messages blocks），这边是**已翻译好的 chat body**
// （messages 数组 + tools），是真正要发给上游的那份，所以单独走一遍计数。

import { createTokenCounter } from "../text-tokens.js";

// 统一保守窗口。取值依据：现网 free 层主流 200k，且错误集中在 -free 模型。
// 未自报窗口的模型按这个值对外宣称（见 context-lookup 的 L4）；转发前也按它判。
export const DEFAULT_FORWARD_MAX_CONTEXT_TOKENS = 200_000;

/** 读取转发前上限；`0`/负数 = 关闭预检（退回旧行为：无脑转发）。非法值按默认。 */
export function forwardMaxContextTokens(env = process.env) {
  const raw = String(env.MSLXDFF_FORWARD_MAX_CONTEXT_TOKENS ?? "").trim();
  if (raw === "") return DEFAULT_FORWARD_MAX_CONTEXT_TOKENS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_FORWARD_MAX_CONTEXT_TOKENS;
  if (n <= 0) return 0;
  const f = Math.floor(n);
  // (0,1) 会被 floor 成 0 —— 那等于悄悄关掉闸门，按非法值回默认（同 context-lookup 的取舍）
  return f > 0 ? f : DEFAULT_FORWARD_MAX_CONTEXT_TOKENS;
}

// 单条消息的文本面（role 名与 tool_call 参数也算：它们同样占上游上下文）
function addMessage(counter, m) {
  if (!m || typeof m !== "object") return;
  const c = m.content;
  if (typeof c === "string") counter.add(c);
  else if (Array.isArray(c)) {
    for (const p of c) {
      if (!p || typeof p !== "object") continue;
      if (typeof p.text === "string") counter.add(p.text);
      else if (p.type === "image") counter.add("x".repeat(4000)); // 图片按固定面值近似（不吃字符但占真实上下文）
    }
  } else if (c != null) counter.add(String(c));
  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) {
      counter.add(String(tc?.function?.name || ""));
      counter.add(String(tc?.function?.arguments || ""));
    }
  }
}

/**
 * 估算**已翻译的 chat body** 的输入 token 数。
 * 逐段喂进同一个计数器再一次性套公式（与 text-tokens 的累计口径一致：逐段各套会乘上「非空至少 1」下限）。
 */
export function estimateChatBodyTokens(body = {}) {
  const counter = createTokenCounter();
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const m of messages) addMessage(counter, m);
  if (Array.isArray(body?.tools) && body.tools.length) {
    try { counter.add(JSON.stringify(body.tools)); } catch { /* 循环引用等异常：不计工具面 */ }
  }
  // tools 的 JSON 里已含 name/description/schema；system 已在 messages 首条里
  return counter.tokens();
}

// 同一次请求的 body 对象会在多个出站口被反复判（via-route → peer → broadband），
// 而大上下文扫描是 O(字符数)。按对象身份缓存，保证「每请求只算一次」（同 ADR-0055 决策 4 的口径）。
const estimateCache = new WeakMap();

function estimateOnce(body) {
  if (!body || typeof body !== "object") return estimateChatBodyTokens(body);
  const hit = estimateCache.get(body);
  if (hit !== undefined) return hit;
  const n = estimateChatBodyTokens(body);
  estimateCache.set(body, n);
  return n;
}

/**
 * 转发前判决。返回 null = 放行；否则给出超限信息（调用方据此短路，**不转发**）。
 * @param {object} body 已翻译的 chat body
 * @param {{limit?:number}} opts limit 缺省读 env
 * @returns {{estimated:number, limit:number, over:number}|null}
 */
export function overForwardLimit(body, opts = {}) {
  const limit = opts.limit === undefined ? forwardMaxContextTokens() : Number(opts.limit) || 0;
  if (!limit || limit <= 0) return null;
  const estimated = estimateOnce(body);
  if (estimated <= limit) return null;
  return { estimated, limit, over: estimated - limit };
}

/** 给客户端看的文案：必须含 `context_length_exceeded` 语义，客户端据此触发压缩。 */
export function contextGuardMessage({ estimated, limit } = {}) {
  return `context_length_exceeded: 请求约 ${estimated ?? "?"} tokens，超过网关注入的转发上限 ${limit ?? "?"}；`
    + "本地节点额度已用尽，为避免把同一份上下文转发给组员后再次超限，请先运行 /compact 压缩上下文再重试。";
}
