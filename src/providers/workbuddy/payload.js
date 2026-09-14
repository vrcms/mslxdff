// workbuddy 出站 payload 改写（逆向官方客户端行为，参考 Sliverkiss/workbuddy2api 的 payload.go/thinking.go）：
//  1. developer → system：上游 role 白名单不含 developer（命中 400 code=11128）
//  2. tool_choice 归一：上游该字段是 string 类型，对象形式 400 code=11101（none 连带删 tools/functions）
//  3. DeepSeek thinking 注入：必须显式 thinking.type=enabled + 有 effort 档位，否则上游按不思考应答；
//     显式 disabled 尊重并删 effort；缺档补默认 "high"
//  4. DeepSeek reasoning_content 回填：会话内任一 assistant 带 reasoning 痕迹时，
//     所有 assistant 必须带 reasoning_content（string，可空串）——requiresReasoningContentOnAssistantMessages
const DEEPSEEK_PREFIX = "deepseek";
const DEFAULT_DEEPSEEK_EFFORT = "high";

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

// 入口：输入 chat body（OpenAI 格式），返回改写后的新对象（messages 浅拷贝，避免污染调用方）。
export function rewriteWorkbuddyPayload(body) {
  if (!body || typeof body !== "object") return body;
  const obj = { ...body };
  obj.messages = Array.isArray(body.messages)
    ? body.messages.map((m) => (m && typeof m === "object" ? { ...m } : m))
    : body.messages;
  normalizeRoles(obj);
  normalizeToolChoice(obj);
  if (isDeepSeekModel(obj.model)) {
    injectThinking(obj);
    backfillReasoningContent(obj);
  }
  return obj;
}
