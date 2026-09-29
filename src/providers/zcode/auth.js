// zcode JWT 工具：解析、过期判断、指纹（日志只准出指纹，全文绝不落日志）。
export function decodeJwtPayload(token) {
  const s = String(token || "");
  const parts = s.split(".");
  if (parts.length < 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload = JSON.parse(json);
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

export function jwtExpiresAt(token) {
  const exp = Number(decodeJwtPayload(token)?.exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
}

export function isJwtExpired(token, now = Date.now()) {
  const at = jwtExpiresAt(token);
  return at != null && at <= now;
}

export function tokenFingerprint(token) {
  const s = String(token || "");
  return s ? s.slice(0, 8) : "";
}
