// qoder 线格式消息转换层：OpenAI/Anthropic messages → Qoder 原生 wire messages。
// 从 payload.js 拆出（体积门 + 职责边界：这里只管"消息形状/配对/缓存标记/会话指纹"，不管请求体装配）。
// 关键事实（2026-10-22 取证，对齐官方 qodercli + dsh-qoder-connect + magpie qoder 插件）：
//  - messages 必须发 Qoder 原生形状（user 带 contents[]、assistant 回传 reasoning_content、tool 带 tool_call_id）；
//  - 注入官方 Qoder agent 人格（缓存稳定种子）；末个可缓存块打 cache_control:ephemeral（Anthropic 系只缓存标记段）；
//  - session_id 按对话稳定（同对话跨请求命中上游 prompt 缓存）；
//  - tool 配对修复：上游对「孤儿 tool result」整体拒收，须补派生 id / 防抢占认领 / 降级不丢内容。
import { createHash } from "node:crypto";

export function blankResponseMeta() {
  return {
    id: "",
    usage: {
      prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
      completion_tokens_details: { reasoning_tokens: 0 },
      prompt_tokens_details: { cached_tokens: 0 },
    },
  };
}

// OpenAI user 消息 → Qoder contents 形状
export function buildUserMessage(text) {
  return {
    role: "user", content: "",
    contents: [{ type: "text", text: String(text || "") }],
    response_meta: blankResponseMeta(),
    reasoning_content_signature: "",
  };
}

export function buildStructuredMessage(role, text) {
  return { role, content: String(text || ""), response_meta: blankResponseMeta(), reasoning_content_signature: "" };
}

export function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    let out = "";
    for (const b of content) {
      const t = typeof b === "object" && b ? b.text : b;
      if (typeof t === "string") out += (out ? "\n\n" : "") + t;
    }
    return out;
  }
  return JSON.stringify(content);
}

// 单段 image → Qoder image_url part；拿不到可用 url 返回 null
function imagePartToUrl(b) {
  // OpenAI 形状 {type:'image_url', image_url:{url}}
  const direct = typeof b.image_url === "string" ? b.image_url : b.image_url?.url;
  if (typeof direct === "string" && direct) return { type: "image_url", image_url: { url: direct } };
  // Anthropic 形状 {type:'image', source:{type:'base64'|'url', media_type, data|url}}
  const src = b.source;
  if (src && typeof src === "object") {
    if (src.type === "url" && typeof src.url === "string" && src.url)
      return { type: "image_url", image_url: { url: src.url } };
    if (src.type === "base64" && src.data && src.media_type)
      return { type: "image_url", image_url: { url: `data:${src.media_type};base64,${src.data}` } };
  }
  return null;
}

// 官方会话人格（对齐 qoder-agent-sdk：magpie 插件同款）：人格行前置、客户端 system 拼后。
// 固定前缀让上游 prompt 缓存跨轮命中，也让模型身份口径稳定（不再自称别名）。
const QODER_SYS = "You are a Qoder agent. Use the instructions below and the tools available to you to assist the user.";
export function withQoderPersona(systemText) {
  const s = String(systemText || "").trim();
  return s ? `${QODER_SYS}\n\n${s}` : QODER_SYS;
}

// tool 配对修复（对齐 magpie #277/#290/#359，实测上游行为）：
//  - 上游对「tool 行没有应答它前面 assistant 的某个 call」的请求整体拒绝
//    （"Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"），
//    客户端丢 id / 上下文压缩截断都会造成孤儿 result → 整个 turn 被枪毙（表现为莫名的 400/空 turn）。
//  - 修法：call 缺 id 按内容派生稳定 id（同 turn 内跨请求一致，不破坏上游缓存）；
//    孤儿 result 认领「其后没有任何 result 点名的那个未应答 call」（防孤儿抢占合法点名），认领不到降级 user 文本。
function callIdFor(at, k, c) {
  const said = typeof c.function?.arguments === "string" ? c.function.arguments : JSON.stringify(c.function?.arguments ?? {});
  return "call_" + createHash("sha256").update(`${at}\0${k}\0${c.function?.name ?? ""}\0${said}`).digest("hex").slice(0, 32);
}

// 从 from 起收集其后所有 result 行点名的 id（user 的 tool_result 数组形态与 tool 行都算），
// 直到下一个 assistant/user 文本行为止——这是"合法点名预约表"，孤儿认领时须避开。
function namedAhead(incoming, from) {
  const names = new Set();
  for (let j = from; j < incoming.length; j++) {
    const m = incoming[j];
    if (!m) continue;
    if (m.role === "tool") { if (m.tool_call_id) names.add(String(m.tool_call_id)); continue; }
    if (m.role === "user" && Array.isArray(m.content) && m.content[0]?.type === "tool_result") {
      for (const b of m.content) if (b?.type === "tool_result" && b.tool_use_id) names.add(String(b.tool_use_id));
      continue;
    }
    break; // 碰到别的角色（assistant 新 turn / user 真话）即停
  }
  return names;
}

// OpenAI messages → Qoder 原生 wire messages（官方形状：user=contents[]；assistant=content+tool_calls+reasoning_content）
export function toQoderWireMessages(incoming) {
  const msgs = incoming || [];
  const out = [];
  let pendingCallIds = []; // 最近一个 assistant 轮里尚未被 result 应答的 call ids（按发出顺序）
  let systemText = "";
  const claimOrDemote = (id, at) => {
    const sid = String(id || "");
    if (sid && pendingCallIds.includes(sid)) {
      pendingCallIds = pendingCallIds.filter((p) => p !== sid);
      return { ok: true, id: sid };
    }
    // 客户端丢了 id / 点名了对不上的 id：认领「后面没人点名」的第一个未应答 call
    const reserved = namedAhead(msgs, at);
    const freeAt = pendingCallIds.findIndex((p) => !reserved.has(p));
    if (freeAt >= 0) return { ok: true, id: pendingCallIds.splice(freeAt, 1)[0] };
    return { ok: false };
  };
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || typeof m !== "object") continue;
    const text = normalizeContent(m.content);
    if (m.role === "system") {
      if (text) systemText = systemText ? systemText + "\n\n" + text : text;
      continue;
    }
    if (m.role === "user") {
      pendingCallIds = [];
      // Anthropic tool_result 数组形态 → tool 行（翻译层产物）
      if (Array.isArray(m.content) && m.content[0]?.type === "tool_result") {
        for (const b of m.content) {
          if (b?.type !== "tool_result") continue;
          const rt = normalizeContent(b.content);
          const claimed = claimOrDemote(b.tool_use_id || "", i);
          if (claimed.ok) out.push({ role: "tool", tool_call_id: claimed.id, content: rt });
          else out.push(buildUserMessage(rt)); // 无路可认领 → 降级 user 文本，内容不丢
        }
        continue;
      }
      if (Array.isArray(m.content)) {
        const parts = [];
        for (const b of m.content) {
          if (!b || typeof b !== "object") continue;
          if (b.type === "text" && typeof b.text === "string" && b.text) { parts.push({ type: "text", text: b.text }); continue; }
          if (b.type === "image" || b.type === "image_url") {
            const p = imagePartToUrl(b);
            if (p) { parts.push(p); continue; }
          }
          const t = typeof b.text === "string" ? b.text : null;
          if (t) parts.push({ type: "text", text: t });
        }
        if (!parts.length && text) parts.push({ type: "text", text });
        out.push({
          role: "user", content: "",
          contents: parts.length ? parts : [{ type: "text", text: "" }],
          response_meta: blankResponseMeta(),
          reasoning_content_signature: "",
        });
        continue;
      }
      out.push(buildUserMessage(text));
      continue;
    }
    if (m.role === "assistant") {
      const hasToolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
      if (!text && !hasToolCalls && !m.reasoning_content) continue; // 空气泡不发
      pendingCallIds = [];
      const msg = buildStructuredMessage("assistant", text || " ");
      if (hasToolCalls) {
        msg.tool_calls = m.tool_calls.map((c, k) => (c?.id ? c : { ...c, id: callIdFor(i, k, c || {}) }));
        pendingCallIds = msg.tool_calls.map((c) => c.id);
      }
      if (m.reasoning_content) msg.reasoning_content = String(m.reasoning_content);
      out.push(msg);
      continue;
    }
    if (m.role === "tool") {
      const claimed = claimOrDemote(m.tool_call_id || "", i);
      if (claimed.ok) {
        const msg = buildStructuredMessage("tool", text);
        msg.tool_call_id = claimed.id;
        if (m.name) msg.name = m.name;
        out.push(msg);
      } else {
        out.push(buildUserMessage(text)); // 孤儿 result → user 文本（上游会整体拒绝 tool 行）
      }
      continue;
    }
    if (text) out.push(buildStructuredMessage(m.role || "user", text));
  }
  // system 人格前置一条（客户端无 system 时也给官方人格，对齐上游客户端行为）
  out.unshift(buildStructuredMessage("system", withQoderPersona(systemText)));
  return out;
}

// 会话指纹（prompt 缓存亲和的关键，对齐 magpie #290）：同一对话（system + 首个 user 相同）
// 恒定同名 → 上游命中会话缓存，首包显著变快；不同对话各不相同。客户端的 key 原文绝不出门。
export function conversationSessionId(userId, modelKey, wireMessages) {
  const sys = [];
  let firstUser = "";
  for (const m of wireMessages) {
    if (m?.role === "system" && m.content) sys.push(String(m.content));
    if (m?.role === "user") {
      firstUser = JSON.stringify(m.contents || m.content || "");
      break;
    }
  }
  const h = createHash("sha256");
  h.update("qoder-conv");
  h.update("\0");
  h.update(String(userId || ""));
  h.update("\0");
  h.update(String(modelKey || ""));
  h.update("\0");
  h.update(JSON.stringify([sys, firstUser]));
  const hex = h.digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// cache_control 标记（对齐 qoder-agent-sdk 真值，magpie #290）：最后一个 user 轮里
// 最后一个非工具块打 ephemeral；末轮是 tool 结果时不标。Anthropic 系模型只缓存标记段，
// 不标 = 整段对话每次全价重算（慢且贵）。输入块原样不动，只加标记。
const UNCACHED_TYPES = new Set(["thinking", "redacted_thinking", "tool_use", "tool_result"]);
function findLastCacheable(blocks) {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const t = blocks[i]?.type;
    if (t && !UNCACHED_TYPES.has(t)) return i;
  }
  return -1;
}
export function cacheMark(wireMessages) {
  const last = wireMessages[wireMessages.length - 1];
  if (!last || last.role !== "user") return wireMessages;
  const blocks = Array.isArray(last.contents) ? last.contents : null;
  if (!blocks || !blocks.length) return wireMessages;
  const idx = findLastCacheable(blocks);
  if (idx < 0) return wireMessages;
  const marked = blocks.slice();
  marked[idx] = { ...marked[idx], cache_control: { type: "ephemeral" } };
  wireMessages[wireMessages.length - 1] = { ...last, contents: marked };
  return wireMessages;
}
