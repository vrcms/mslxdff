/**
 * Cline 指纹头：官方靠这些头识别“是不是 Cline 客户端”
 * 缺少即 403: "only available via Cline product surfaces"
 * 逆向自 pingmike2/cline2api-workers worker.js clineHeaders
 */
export function clineHeaders(sessionId, token) {
  return {
    Authorization: `Bearer workos:${token}`,
    "Content-Type": "application/json",
    "User-Agent": "Cline/3.0.47",
    "HTTP-Referer": "https://cline.bot",
    "X-Title": "Cline",
    "X-IS-MULTIROOT": "false",
    "X-CLIENT-TYPE": "cline-sdk",
    "X-CLIENT-VERSION": "3.0.47",
    "X-PLATFORM": "terminal",
    "X-PLATFORM-VERSION": "3.0.47",
    "X-CORE-VERSION": "0.0.66",
    "X-Task-ID": sessionId,
  };
}

export function isRefreshToken(key) {
  const s = String(key || "").trim();
  if (!s) return false;
  // sk_ / sk- 形态直接视为旧直连 key（OpenAI 兼容网关），不走 refresh 链
  if (s.startsWith("sk_") || s.startsWith("sk-")) return false;
  // refreshToken 通常为 JWT 或长随机串，长度 > 20 且含 . 或 -
  if (s.length > 20) return true;
  return false;
}
