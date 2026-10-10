// raccoon 鉴权材料工具：JWT 过期判断、token 指纹、uid 归一。
// 指纹用于 CLI 脱敏回执与日志——**token 原文绝不出现在输出里**。
import { createHash } from "node:crypto";

/** 解析 JWT payload 的 `exp`（秒 → 毫秒）；坏格式/缺字段返回 undefined。 */
export function decodeJwtExpMs(token) {
  if (typeof token !== "string" || token.length === 0) return undefined;
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
    const exp = payload.exp;
    if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) return undefined;
    return exp * 1000;
  } catch {
    return undefined;
  }
}

/**
 * 凭据到期时刻（毫秒）：优先账号文档里的 `expires_at`（字符串，支持秒或毫秒），
 * 缺失时回落 JWT 自身的 `exp`。两者都拿不到 → undefined（视为「不知何时过期」，不主动判过期）。
 */
export function raccoonCredentialExpiresAtMs(credential) {
  const raw = credential?.expires_at;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
  }
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw > 1e12 ? raw : raw * 1000;
  return decodeJwtExpMs(credential?.access_token);
}

/** 是否已过期（拿不到到期时刻时保守返回 false，交给上游 401 判）。 */
export function isRaccoonExpired(credential, now = Date.now()) {
  const exp = raccoonCredentialExpiresAtMs(credential);
  return exp === undefined ? false : now >= exp;
}

/** 到期前提前量（默认 60s）：临期即刷新，避免请求正好撞在过期瞬间。 */
export const RACCOON_REFRESH_SKEW_MS = 60_000;

export function isRaccoonExpiringSoon(credential, now = Date.now(), skewMs = RACCOON_REFRESH_SKEW_MS) {
  const exp = raccoonCredentialExpiresAtMs(credential);
  return exp === undefined ? false : now + skewMs >= exp;
}

/** token 指纹：sha256 前 8 位十六进制。**唯一允许出现在日志/CLI 里的 token 表示**。 */
export function raccoonTokenFingerprint(token) {
  const s = String(token || "");
  if (!s) return "";
  try {
    return createHash("sha256").update(s).digest("hex").slice(0, 8);
  } catch {
    return "";
  }
}

/** uid 归一：优先 user_info 的 id，其次 office/userId，最后回退 token 指纹（保证非空且稳定）。 */
export function resolveRaccoonUid({ userId = "", officeIdentity = "", token = "" } = {}) {
  for (const candidate of [userId, officeIdentity]) {
    const s = String(candidate || "").trim();
    if (s) return s;
  }
  return raccoonTokenFingerprint(token);
}
