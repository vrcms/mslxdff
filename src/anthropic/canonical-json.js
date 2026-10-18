/**
 * 键序规范化 JSON —— 出站请求体的「跨轮字节稳定」层。
 *
 * 1:1 照抄 cc-switch `src-tauri/src/proxy/json_canonical.rs`（v3.19 线）：
 *  · `canonical_json_string`：对象键**按序**排列、紧凑输出（无空格换行）；数组保序；数字原样，
 *    不做浮点规格化（Rust 侧 `Value::Number::to_string()`，本实现用 `String(n)`）。
 *  · `canonicalize_value`：递归重建对象、按键序插入 —— 让后续 `JSON.stringify` 的字节序恒定。
 *
 * 为什么只在 /v1/messages 用：前缀缓存按「字节前缀」命中，同一逻辑 body 若键序漂移，
 * 上游就会从头重算 prefill（实测 TTFT 与 prompt 长度成正比 = 每轮全量 prefill）。
 * 客户端（Claude Code）回传历史里的 tool_use input 也可能由它自己重新序列化，
 * 故 arguments 单独走 canonical（见 request-body.js）。
 *
 * 已知差异：Rust 的 `sort_by_key` 按字节序，JS `Array#sort` 按 UTF-16 码元序 ——
 * 对 ASCII 键名（本协议全部字段名）两者等价；非 ASCII 键名理论上可能不同，本仓无此输入。
 */

/** 单值 JSON 字面量（字符串转义走 JSON.stringify，与 Rust `serde_json::to_string` 同形）。 */
function literal(v) {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "string") return JSON.stringify(v);
  if (t === "number") return Number.isFinite(v) ? String(v) : "null";
  if (t === "boolean") return v ? "true" : "false";
  return "null";
}

/**
 * 规范 JSON 字符串：对象键序排列 + 紧凑输出。
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return literal(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  }
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

/**
 * 递归重建：对象按键序插入（数组保序）。出站 body 过一遍后，同一逻辑内容必然产出同一份字节。
 * @param {unknown} value
 * @returns {unknown}
 */
export function canonicalizeValue(value) {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalizeValue(value[k]);
    return out;
  }
  return value;
}
