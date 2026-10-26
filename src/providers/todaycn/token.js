// todaycn accessToken 缓存：每枚 refreshCredential 换一枚 10 分钟 JWT，按 exp 提前刷新。
// refresh 端点实测：GET {AUTH}/api/auth/token，Authorization: Bearer <refreshCredential> → { token }。
// refreshCredential 实测**不轮换**（连续多次刷新同一枚仍有效）→ 本模块不回写凭据，只缓存 token。

import { compatFetch } from "../../compat.js";
import { TODAYCN_AUTH_BASE, TODAYCN_TOKEN_SKEW_MS } from "./const.js";

/** JWT payload 解码（不验签，只取 exp；失败给 0 = 视为立即过期）。 */
export function decodeJwtExpMs(token = "") {
  try {
    const part = String(token).split(".")[1];
    if (!part) return 0;
    const json = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return Number(json?.exp || 0) * 1000;
  } catch {
    return 0;
  }
}

export function createTokenStore({ fetchImpl, authBase = TODAYCN_AUTH_BASE, skewMs = TODAYCN_TOKEN_SKEW_MS, timeoutMs = 15_000, clock = Date.now } = {}) {
  const call = fetchImpl || compatFetch;
  const cache = new Map(); // credential → { token, expMs }

  async function refresh(credential, { signal } = {}) {
    const ctrl = signal ? null : new AbortController();
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await call(`${authBase}/api/auth/token`, {
        headers: {
          Authorization: `Bearer ${credential}`,
          Accept: "application/json",
          Origin: "https://todayai.cn",
        },
        signal: signal || (ctrl ? ctrl.signal : undefined),
      });
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        return { ok: false, status: res.status, reason: `refresh ${res.status} ${text.slice(0, 160)}`, authFailed: res.status === 401 || res.status === 403 };
      }
      let token = "";
      try { token = String(JSON.parse(text)?.token || ""); } catch {}
      if (!token) return { ok: false, status: res.status, reason: "refresh 响应里没有 token", authFailed: false };
      cache.set(credential, { token, expMs: decodeJwtExpMs(token) });
      return { ok: true, token, status: res.status };
    } catch (e) {
      return { ok: false, status: 0, reason: `refresh 网络失败 ${String(e?.message || e).slice(0, 120)}`, authFailed: false };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 取可用 token：缓存未过期直接给；否则刷新。force=true 忽略缓存（上游 401 后重试用）。 */
  async function getToken(credential, { force = false, signal } = {}) {
    const cred = String(credential || "").trim();
    if (!cred) return { ok: false, status: 401, reason: "empty credential", authFailed: true };
    const hit = cache.get(cred);
    if (!force && hit && hit.expMs - clock() > skewMs) return { ok: true, token: hit.token, cached: true };
    return refresh(cred, { signal });
  }

  function forget(credential) {
    cache.delete(String(credential || "").trim());
  }

  return { getToken, forget, _cache: () => cache };
}