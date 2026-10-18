// raccoon 上游统一信封：`{ code, message, details, data }`（与 pack.js 的 parseEnvelope 同形）。
// ⚠ 两代通道的成功码不同（2026-10 上游改版）：旧 /api/web/* 用数字 `0`，新 /api/iam/v1/* 用字符串 `"OK"`。
//   故 `code` 原样保留（数字或字符串），判成功一律走 isRaccoonOk()——**不能**再用 `code === 0`：
//   字符串码一律不等于 0（把 "OK" 判成失败），而把它兜底成 0 又会把 `AUTH_QRCODE_EXPIRED` 判成成功。
// 登录态类业务码：200001 未带 token、200003 登录态过期 —— 见 const.js 的 RACCOON_ERROR_KINDS。
export function parseRaccoonEnvelope(payload, status = 200) {
  const record = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload : {};
  const raw = record.code;
  const code = typeof raw === "number" || typeof raw === "string" ? raw : status >= 400 ? status : 0;
  const message = typeof record.message === "string" ? record.message : "";
  const details = typeof record.details === "string" ? record.details : "";
  const data = typeof record.data === "object" && record.data !== null && !Array.isArray(record.data) ? record.data : undefined;
  return { code, message, details, data, status };
}

/** 业务成功判据（两代通道通用）：数字 0，或新 IAM 通道的字符串 "OK"。 */
export function isRaccoonOk(envelope) {
  return envelope?.code === 0 || envelope?.code === "OK";
}

/** 人话错误文本：`message: details`，都没有时用调用方给的兜底句。 */
export function raccoonEnvelopeText(envelope, fallback = "请求失败") {
  const parts = [envelope?.message, envelope?.details].filter((s) => typeof s === "string" && s.length > 0);
  return parts.length > 0 ? parts.join("：") : fallback;
}

/** 登录态失效判据：HTTP 401 或业务码 200001/200003。 */
export function isRaccoonAuthFailure(envelope, status) {
  if (status === 401) return true;
  return envelope?.code === 200001 || envelope?.code === 200003;
}
