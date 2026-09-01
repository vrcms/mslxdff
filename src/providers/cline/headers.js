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

export function isRefreshToken(key, providerId = "") {
  const s = String(key || "").trim();
  if (!s) return false;
  // 仅 cline 系供应商才有 refreshToken 形态（WorkOS 设备授权）；其他一律走传统 Key
  const pid = String(providerId || "").toLowerCase();
  const baseHint = pid;
  const isCline = baseHint.includes("cline");
  if (!isCline) {
    // 非 cline 供应商，即使长串也不视为 refreshToken，默认传统 Key（以后 xxx.bot 再扩展此处白名单）
    return false;
  }
  if (s.startsWith("sk_") || s.startsWith("sk-")) return false;
  if (s.length > 20) return true;
  return false;
}
