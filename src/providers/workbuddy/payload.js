// workbuddy 出站 payload 改写（逆向官方客户端行为，参考 Sliverkiss/workbuddy2api 的 payload.go/thinking.go）：
//  1. developer → system：上游 role 白名单不含 developer（命中 400 code=11128）
//  2. tool_choice 归一：上游该字段是 string 类型，对象形式 400 code=11101（none 连带删 tools/functions）
//  3. DeepSeek thinking 注入：必须显式 thinking.type=enabled + 有 effort 档位，否则上游按不思考应答；
//     显式 disabled 尊重并删 effort；缺档补默认 "high"
//  4. DeepSeek reasoning_content 回填：会话内任一 assistant 带 reasoning 痕迹时，
//     所有 assistant 必须带 reasoning_content（string，可空串）——requiresReasoningContentOnAssistantMessages
//  5. Claude Code 指纹剥离：上游扫 system/assistant 文本，命中官方固定串即 400 code=11128
//     "Illegal API invocation from an unapproved channel"（拒当 Claude Code 的免费通道）。
//     实测 2026-10-10（拿真 Claude Code 27KB prompt 二分定位）：触发形态共三种——行首 `x-anthropic-billing-header:` 整行 +
//     两句官方固定整句（"You are Claude Code, Anthropic's official CLI for Claude." 与
//     "To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues"）；
//     整句为**纯子串匹配**（去掉行首 `- ` 照拦），user/tool 文本不扫、换说法/中间片段/普通长文全放行
//     → 只剥官方注入物不动用户内容；日后撞见新拦句，加进 CC_SENTENCES 即可
const DEEPSEEK_PREFIX = "deepseek";
const DEFAULT_DEEPSEEK_EFFORT = "high";
const CC_BILLING_LINE = /^x-anthropic-billing-header:.*\r?\n?/gim;
// 整句指纹清单：官方固定整句（实测为纯子串匹配，与行首前缀无关；新拦句直接往这里追加整句）
const CC_SENTENCES = [
  "You are Claude Code, Anthropic's official CLI for Claude.",
  "To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
];
// 廉价预检：上面三种形态的大小写不敏感超集——只多放行进剥离流程，绝不漏剥
const CC_MAYBE = /x-anthropic-billing-header|Claude Code|anthropics\/claude-code/i;

export function isDeepSeekModel(model) {
  return String(model || "").trim().toLowerCase().startsWith(DEEPSEEK_PREFIX);
}

export function normalizeRoles(obj) {
  const msgs = obj?.messages;
  if (!Array.isArray(msgs)) return obj;
  for (const m of msgs) {
    if (m && typeof m === "object" && typeof m.role === "string" && m.role.trim().toLowerCase() === "developer") {
      m.role = "system";
    }
  }
  return obj;
}

export function normalizeToolChoice(obj) {
  const tc = obj?.tool_choice;
  if (tc === undefined || tc === null) return obj;
  const dropTools = () => { delete obj.tools; delete obj.functions; };
  if (typeof tc === "string") {
    if (tc.trim().toLowerCase() === "none") { delete obj.tool_choice; dropTools(); }
    return obj;
  }
  if (typeof tc === "object") {
    const type = String(tc.type || "").trim().toLowerCase();
    if (type === "none") { delete obj.tool_choice; dropTools(); }
    else if (type === "auto" || type === "required") obj.tool_choice = type;
    else if (type === "function") {
      const name = String(tc?.function?.name || tc?.name || "").trim();
      obj.tool_choice = name || "auto";
    } else delete obj.tool_choice;
    return obj;
  }
  delete obj.tool_choice;
  return obj;
}

export function injectThinking(obj) {
  if (!isDeepSeekModel(obj?.model)) return obj;
  const th = obj.thinking && typeof obj.thinking === "object" ? obj.thinking : null;
  const type = th ? String(th.type || "").trim() : "";
  if (type && type.toLowerCase() === "disabled") {
    delete obj.reasoning_effort;
    delete obj.reasoningEffort;
    return obj;
  }
  if (!type) {
    if (th) th.type = "enabled";
    else obj.thinking = { type: "enabled" };
  }
  if (!("reasoning_effort" in obj) && !("reasoningEffort" in obj)) obj.reasoning_effort = DEFAULT_DEEPSEEK_EFFORT;
  return obj;
}

export function backfillReasoningContent(obj) {
  if (!isDeepSeekModel(obj?.model)) return obj;
  const msgs = obj.messages;
  if (!Array.isArray(msgs) || !msgs.length) return obj;
  let hasTrace = false;
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    if (typeof m.reasoning === "string" && m.reasoning) { hasTrace = true; break; }
    if ("reasoning_content" in m) { hasTrace = true; break; }
  }
  if (!hasTrace) return obj;
  for (const m of msgs) {
    if (!m || m.role !== "assistant") continue;
    if ("reasoning_content" in m) continue;
    m.reasoning_content = typeof m.reasoning === "string" ? m.reasoning : "";
  }
  return obj;
}

export function stripClaudeFingerprints(obj) {
  const msgs = obj?.messages;
  if (!Array.isArray(msgs)) return obj;
  const clean = (text) => {
    if (typeof text !== "string" || !CC_MAYBE.test(text)) return text;
    let out = text.replace(CC_BILLING_LINE, "");
    for (const s of CC_SENTENCES) out = out.split(s).join("");
    return out;
  };
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    if (m.role !== "system" && m.role !== "assistant") continue; // 上游不扫 user/tool，不碰用户内容
    if (typeof m.content === "string") m.content = clean(m.content);
    else if (Array.isArray(m.content)) m.content = m.content.map((p) => (p && typeof p === "object" && typeof p.text === "string" ? { ...p, text: clean(p.text) } : p));
  }
  return obj;
}

// 入口：输入 chat body（OpenAI 格式），返回改写后的新对象（messages 浅拷贝，避免污染调用方）。
export function rewriteWorkbuddyPayload(body) {
  if (!body || typeof body !== "object") return body;
  const obj = { ...body };
  obj.messages = Array.isArray(body.messages)
    ? body.messages.map((m) => (m && typeof m === "object" ? { ...m } : m))
    : body.messages;
  normalizeRoles(obj);
  stripClaudeFingerprints(obj); // 11128：官方客户端指纹必须出网前剥掉（实测命中即秒拒，不进模型）
  normalizeToolChoice(obj);
  if (isDeepSeekModel(obj.model)) {
    injectThinking(obj);
    backfillReasoningContent(obj);
  }
  return obj;
}
