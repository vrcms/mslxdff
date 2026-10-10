// raccoon 上游统一信封：`{ code, message, details, data }`（与 pack.js 的 parseEnvelope 同形）。
// 约定：code === 0 为成功；HTTP 状态码仅在 code 缺失时兜底（上游错误也可能带 200）。
// 登录态类业务码：200001 未带 token、200003 登录态过期 —— 见 const.js 的 RACCOON_ERROR_KINDS。
export function parseRaccoonEnvelope(payload, status = 200) {
  const record = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload : {};
  const code = typeof record.code === "number" ? record.code : status >= 400 ? status : 0;
  const message = typeof record.message === "string" ? record.message : "";
  const details = typeof record.details === "string" ? record.details : "";
  const data = typeof record.data === "object" && record.data !== null && !Array.isArray(record.data) ? record.data : undefined;
  return { code, message, details, data, status };
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
