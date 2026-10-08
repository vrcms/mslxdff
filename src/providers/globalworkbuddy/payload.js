// 国际版出站 chat body 改写。四条规则**全部是本 provider 现网实测**（2026-10-05，见 FINDINGS 结论 C/C 表），
// 不是从国内版 `workbuddy/payload.js` 搬来的经验值。
//
//   规则                     实测响应
//   缺首条 system       →    400/11128 "first message is not system prompt"
//   role:"developer"    →    400/11128 "Illegal API invocation from an unapproved channel"
//   tool_choice 传对象  →    400/11101 "cannot unmarshal object into ... Request.tool_choice of type string"
//   reasoning_effort:"off" → 国际版 GPT 系 400/11133（参考仓库 issue #49/#50 同款；本区只删这一个字面量）
//
// ⚠ **刻意不做**的两件事（国内版 payload.js 里有，国际版未取证，凭经验加等于猜上游）：
//   · DeepSeek `thinking.type=enabled` 注入 —— 国际版是否需要/是否接受该非标字段，未测；
//   · assistant `reasoning_content` 回填 —— 同上。要加先跑探针（`.scratch/globalworkbuddy/probe*.mjs` 有现成骨架）。
export const INTERNATIONAL_SYSTEM_PROMPT = "You are a helpful assistant.";

/** role 归一：上游白名单不含 developer。就地改，返回改动计数供日志。 */
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

/** tool_choice 必须是 string；`none` 连带删掉 tools/functions（上游会拒「说不调工具又给工具」）。 */
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

/** 只删适配器自造的 `off`；`low/medium/high/xhigh/max` 与显式 `none` 原样透传。 */
export function dropUnsupportedEffort(obj) {
  if (obj?.reasoning_effort === "off") delete obj.reasoning_effort;
  return obj;
}

/** 首条必须 system：缺了就**前插**一条中性提示，绝不合并/改写用户已有消息。 */
export function ensureLeadingSystem(obj) {
  if (!Array.isArray(obj?.messages)) return obj;
  const first = obj.messages[0];
  if (first && typeof first === "object" && first.role === "system") return obj;
  obj.messages.unshift({ role: "system", content: INTERNATIONAL_SYSTEM_PROMPT });
  return obj;
}

/**
 * 入口：吃 OpenAI 形状 body，返回**新对象**（messages 浅拷贝，不污染调用方）。
 * 上游拒绝非流式，故强制 `stream: true`。
 */
export function rewriteGlobalworkbuddyPayload(body) {
  if (!body || typeof body !== "object") return body;
  const obj = { ...body, stream: true };
  obj.messages = Array.isArray(body.messages)
    ? body.messages.map((m) => (m && typeof m === "object" ? { ...m } : m))
    : body.messages;
  normalizeRoles(obj);
  normalizeToolChoice(obj);
  dropUnsupportedEffort(obj);
  ensureLeadingSystem(obj);
  return obj;
}
