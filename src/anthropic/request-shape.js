/**
 * /v1/messages 请求形状的「取稳与清洗」原语 —— 1:1 照抄 cc-switch。
 *
 * 三件套：
 *  1. `stripLeadingBillingHeader` —— 剥 system 文本**开头**的 `x-anthropic-billing-header:` 行
 *     （照抄 transform.rs:17-55，对应 cc-switch #2350）。Claude Code 会把含轮换 `cch=` 的
 *     计费头塞在 system 最前面；它每轮变一次 → 整条前缀缓存失效 → 每轮全量 prefill。
 *     只在开头剥，后文再出现同样的字符串一律保留（那是用户自己写的内容）。
 *  2. `cleanToolSchema` —— 工具参数 schema 清洗（照抄 transform.rs:563-594）：根缺 `type` 时补
 *     `"object"` 并顺带补 `properties: {}`，全树删 `format: "uri"`（严格上游会拒），嵌套递归。
 *  3. `isOpenAiOSeries` —— o 系列（o1/o3/o4…）需 `max_completion_tokens` 而非 `max_tokens`
 *     （照抄 transform.rs:57-63 的意图；本仓模型 id 带供应商前缀，故按末段判定）。
 */

const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

/**
 * 剥 system 开头的计费头行（含紧随的一个空行）。
 * 无换行（整段就是这一行）→ 返回空串，与 cc-switch 一致。
 * @param {unknown} text
 * @returns {string}
 */
export function stripLeadingBillingHeader(text) {
  const s = typeof text === "string" ? text : "";
  if (!s.startsWith(BILLING_HEADER_PREFIX)) return s;
  const nl = s.search(/[\r\n]/);
  if (nl < 0) return "";
  let rest = s.slice(nl + 1);
  if (s[nl] === "\r" && rest.startsWith("\n")) rest = rest.slice(1);
  if (rest.startsWith("\r\n")) return rest.slice(2);
  if (rest.startsWith("\n") || rest.startsWith("\r")) return rest.slice(1);
  return rest;
}

/** 递归清洗一份 JSON schema（不修改入参：每层都产新对象）。 */
export function cleanToolSchema(schema) {
  return cleanSchemaInner(schema, true);
}

function cleanSchemaInner(schema, isRoot) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const out = { ...schema };
  // 删 $schema 元字段（JSON Schema draft 声明）：它不是 OpenAI function parameters 的字段；
  // agentrouter 实测 2026-10-21——带 `$schema: draft/2020-12` 的空参数工具（Claude Code 内建
  // CronList 等）被其 new_api 内核按更严的校验语义判 `null is not of type "array"`（400），
  // 去掉 $schema 即 200。嵌套层同样可能出现，逐层删。
  delete out.$schema;
  const missingType = isRoot && !("type" in out);
  if (missingType) out.type = "object";
  if (missingType && !("properties" in out)) out.properties = {};
  // 根层 properties 存在但缺 required 时补 `required: []`：agentrouter 实测 2026-10-21——其
  // new_api 后端异构副本里部分实例把缺省 required 归一成 null 再按 array 校验，随机报
  // `Invalid schema for function 'X': null is not of type "array"`（400）。现网 A/B 各 10 发：
  // 缺失版 200×5/400×3/500×2，补 required:[] 版 200×10——显式空数组即无从归一 null，
  // 且 required:[] 对 OpenAI/Anthropic 均合法，属通用正确形状（不止为一家打补丁）。
  if (isRoot && out.properties && typeof out.properties === "object" && !Array.isArray(out.properties) && !("required" in out)) {
    out.required = [];
  }
  if (out.format === "uri") delete out.format;
  if (out.properties && typeof out.properties === "object" && !Array.isArray(out.properties)) {
    const props = {};
    for (const k of Object.keys(out.properties)) props[k] = cleanSchemaInner(out.properties[k], false);
    out.properties = props;
  }
  if (out.items !== undefined) out.items = cleanSchemaInner(out.items, false);
  return out;
}

/** OpenAI o 系列（o1/o3/o4-mini…）：只看 id 末段，避免供应商前缀（如 `openai/o3`）干扰。 */
export function isOpenAiOSeries(model) {
  const id = String(model || "").split("/").pop() || "";
  return /^o\d(?:$|[-.])/.test(id.toLowerCase());
}
