// 国际版 token 生命周期。与国内版 `workbuddy/auth.js` 有两处**有意不同**（都是取证换来的）：
//  ① 刷新响应里的 `domain` / `expiresIn` **要采纳**（国内版只取 token 对，等于把上游的账号迁移信息丢掉）；
//  ② 刷新请求**不带 Bearer**（见 `headers.js` 通道隔离），国内版带着可能已过期的 accessToken 打刷新口。
// ⚠ 只认「明确失败」：拿不到新 accessToken 一律返回 null 交给上层，绝不抛穿对话链路。
import { compatFetch, timeoutSignal } from "../../compat.js";
import { joinUrl } from "../base.js";
import { BASE, REFRESH_PATH, DOMAIN, JSON_TIMEOUT_MS, REFRESH_MARGIN_MS } from "./constants.js";
import { refreshHeaders } from "./headers.js";
import { classifyUpstreamError } from "./errors.js";

/** JWT `exp`（秒）；非 JWT/解不出一律 0 = 「不主动刷新」，比猜一个安全。 */
export function decodeJwtExp(token) {
  try {
    const payload = String(token || "").split(".")[1];
    if (!payload) return 0;
    let b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4;
    if (pad) b64 += "=".repeat(4 - pad);
    const json = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    return Number(json.exp || 0);
  } catch { return 0; }
}

export function createAuthService({
  baseUrl = BASE,
  fetchImpl,
  clock = Date.now,
  dispatcher,
  applyRefresh,          // 注入落盘（测试用假实现）；缺省走 account-store.applyTokenRefresh
  marginMs = REFRESH_MARGIN_MS,
} = {}) {
  if (!fetchImpl) fetchImpl = compatFetch;
  const resolvedBase = String(baseUrl || BASE).trim().replace(/\/+$/, "");
  const inflight = new Map(); // uid → Promise，同一号并发只刷一次

  async function doRefresh(cred) {
    const url = joinUrl(resolvedBase, REFRESH_PATH);
    try {
      const opts = { method: "POST", headers: refreshHeaders(cred), body: "{}", signal: timeoutSignal(JSON_TIMEOUT_MS) };
      if (dispatcher) opts.dispatcher = dispatcher;
      const res = await fetchImpl(url, opts);
      const text = await res.text();
      let j;
      try { j = JSON.parse(text); } catch { return null; }
      if (j.code !== 0 || !j.data?.accessToken) {
        // 刷新口自己说「会话死了」才算真死；网络/5xx 之类返回 null 让上层换号，别把 refreshToken 烧光
        const cls = classifyUpstreamError(res.status, text);
        if (cls.kind !== "session_dead") {
          try { console.error(`[globalworkbuddy] refresh 被拒（${cls.code || cls.kind}），保留凭据不换思路重试`); } catch {}
        }
        return null;
      }
      const out = {
        accessToken: String(j.data.accessToken),
        refreshToken: String(j.data.refreshToken || cred.refreshToken || ""),
        expiresAt: Number(j.data.expiresIn) > 0 ? Math.floor(Date.now() / 1000) + Number(j.data.expiresIn) : 0,
        domain: String(j.data.domain || cred.domain || DOMAIN),
      };
      const persist = applyRefresh || (await import("./account-store.js")).applyTokenRefresh;
      try {
        await persist({ uid: cred.uid, oldKey: cred.accessToken, accessToken: out.accessToken, refreshToken: out.refreshToken, expiresAt: out.expiresAt, domain: out.domain, enterpriseId: cred.enterpriseId || "" });
      } catch (err) {
        console.error(`[globalworkbuddy] token 落盘失败（刷新已成功，重启将丢失）: ${String(err?.message || err).slice(0, 200)}`);
      }
      return out;
    } catch { return null; }
  }

  /** 返回新 accessToken（失败 null）。并发去重按 uid。 */
  async function refreshTokenFor(cred) {
    if (!cred?.uid || !cred?.refreshToken) return null;
    const key = String(cred.uid);
    if (inflight.has(key)) {
      try { return (await inflight.get(key))?.accessToken || null; } catch { return null; }
    }
    const p = doRefresh(cred);
    inflight.set(key, p);
    try {
      const r = await p;
      return r?.accessToken || null;
    } finally { inflight.delete(key); }
  }

  /** 临期（<margin 且未过期太久）先刷，省掉一次 401 往返。 */
  function maybeProactiveRefresh(cred) {
    try {
      const exp = decodeJwtExp(cred?.accessToken);
      if (!exp) return;
      const remain = exp * 1000 - clock();
      if (remain < marginMs && remain > -60 * 60 * 1000) {
        void refreshTokenFor(cred).catch(() => {});
      }
    } catch {}
  }

  return { refreshTokenFor, maybeProactiveRefresh, decodeJwtExp, _inflight: inflight };
}
