import { joinUrl } from "../base.js";
import { compatFetch } from "../../compat.js";
import { WORKBUDDY_DEFAULT_BASE_URL } from "../../state/schemas/provider.js";
import { applyTokenRefresh } from "./account-store.js";

export function decodeJwtExp(token) {
  try {
    const payload = String(token || "").split(".")[1];
    if (!payload) return 0;
    let b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4;
    if (pad) b64 += "=".repeat(4 - pad);
    const json = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    return Number(json.exp || 0);
  } catch {
    return 0;
  }
}

export function isInsufficientStatus(status, bodyText, cached) {
  if (cached && Number(cached.total) === 0) return true;
  if (status === 402) return true;
  if (status === 403 || status === 429) {
    const t = String(bodyText || "").toLowerCase();
    if (t.includes("insufficient") || t.includes("quota") || t.includes("balance") || t.includes("credit") || t.includes("exhaust") || t.includes("402") || t.includes("10002") || t.includes("10003")) return true;
  }
  return false;
}

// 频率限制：上游「这个号这一秒用量超了」——该换号顶，但**不是**这个号没额度了。
// 与 isInsufficientStatus 严格分开：后者命中会被 chat.js 把该号余额标 0（永久跳过），
// 而腾讯 workbuddy 的 6004 是「使用量已超出频率限制，将在 <时间> 重置」+ 中文措辞，
// 既不含任何英文字样也没有额度码——历史上正是这里不认，导致 429 原样吐给客户端、从不换号。
// Note: 为什么 6004 必须走独立判定而不是并入 insufficient — 见 .agents/notes/implemented/bug-fix/2026-10-18-workbuddy-6004-rate-limit-rotate.md
export function isRateLimitedStatus(status, bodyText) {
  if (status !== 429) return false;
  const t = String(bodyText || "");
  if (/"code"\s*:\s*6004\b/.test(t)) return true;
  const lower = t.toLowerCase();
  if (lower.includes("frequency limit") || lower.includes("rate limit") || lower.includes("too many requests")) return true;
  if (t.includes("频率限制") || t.includes("请求过于频繁") || t.includes("使用量已超出")) return true;
  return false;
}

// 上游 msg 里的重置时刻（"将在 2026-10-18 21:14:48 UTC+8 重置"）→ 建议冷却毫秒数；
// 解析不出返回 0，调用方退回到固定冷却档，绝不因此把号判死。
export function parseRateLimitResetMs(bodyText, clock = Date.now) {
  const m = String(bodyText || "").match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(?:UTC\+8)?\s*重置/);
  if (!m) return 0;
  const at = Date.parse(`${m[1]}T${m[2]}+08:00`);
  if (!Number.isFinite(at)) return 0;
  const ms = at - clock();
  return ms > 0 ? ms : 0;
}

// 账号级风控封禁：腾讯 workbuddy `403 {"code":11140,"msg":"request illegal",displayMsg:"…restricted due to unusual activity/账号存在异常行为…"}`。
// 与 auth 失败、额度耗尽、限流都不同：**刷新 token 无效**（2026-10-21 实测：refresh 成功换发新 token 后照样 11140，
// 且换新 UA/完整客户端头集合同样 11140——判的是账号本体，不是凭据或请求指纹）。
// 命中即应长冷却该号并如实把 403 透回，绝不进 refresh→重打 的连锁（旧链每个用户请求白烧 号数×2 次上游调用 + 号数 次 refresh）。
export function isAccountRestricted(status, bodyText) {
  if (status !== 403) return false;
  const t = String(bodyText || "");
  if (/"code"\s*:\s*11140\b/.test(t)) return true;
  const lower = t.toLowerCase();
  return lower.includes("request illegal") || lower.includes("restricted due to unusual activity") || t.includes("账号存在异常行为");
}

export function isAuthError(status, bodyText) {
  if (status === 401 || status === 403) return true;
  const t = String(bodyText || "").toLowerCase();
  if (t.includes("unauthorized") || t.includes("authenticate") || t.includes("invalid token") || t.includes("token expired") || t.includes("token invalid") || t.includes("access token") || t.includes("login expired") || t.includes("need login") || t.includes("session expired")) return true;
  if (t.includes("code") && (t.includes("401") || t.includes("403")) && t.includes("token")) return true;
  if (status === 400 && t.includes("token")) return true;
  return false;
}
export function createAuthService({
  baseUrl,
  fetchImpl,
  clock = Date.now,
  dispatcher,
  file,
  store, // optional { saveProviderConfig, keysRef, authListRef } or custom saveFn
  saveFn,
} = {}) {
  const resolvedBase = baseUrl ? String(baseUrl).trim().replace(/\/+$/, "") : WORKBUDDY_DEFAULT_BASE_URL;
  // 兼容层统一取（undici 优先，老 Node 兜底）
  if (!fetchImpl) fetchImpl = compatFetch;

  const inflightRefresh = new Map();

  async function refreshTokenFor(key, auth) {
    const rt = auth?.refreshToken;
    const uid = auth?.uid;
    if (!rt || !uid) return null;
    const dedupKey = String(uid);
    if (inflightRefresh.has(dedupKey)) {
      try { return await inflightRefresh.get(dedupKey); } catch { return null; }
    }
    const p = (async () => {
      const url = joinUrl(resolvedBase, "/v2/plugin/auth/token/refresh");
      // 回退到 2026-10-21 17:09 实测**可用**的旧头形（refresh 成功换发过新 token）：refresh 无活体抓包，
      // 不赌未验证口径；11140 只打 chat、refresh 不在风控画像主战场。X-Refresh-Token 是 refresh 特有凭据头。
      // X-Auth-Refresh-Source: "plugin" 是 CLI bundle 三条 refreshSession 逐字共有的真值（@7064132/@7126898/@7144850），补上无副作用。
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "X-Refresh-Token": rt,
        "X-Auth-Refresh-Source": "plugin",
        "X-User-Id": uid,
        "X-Domain": auth.domain || "www.codebuddy.cn",
        "User-Agent": "CLI/2.115.0 WorkBuddy/2.115.0",
        Origin: "https://www.codebuddy.cn",
        Referer: "https://www.codebuddy.cn/",
      };
      try {
        const opts = { method: "POST", headers, body: "{}" };
        if (dispatcher) opts.dispatcher = dispatcher;
        const res = await fetchImpl(url, opts);
        const text = await res.text();
        let j;
        try { j = JSON.parse(text); } catch { return null; }
        if (j.code === 0 && j.data?.accessToken) {
          const newAt = j.data.accessToken;
          const newRt = j.data.refreshToken || rt;
          // attempt to persist if store provided（落盘细节单一源：account-store.applyTokenRefresh）
          try {
            if (saveFn) {
              await saveFn({ newAt, newRt, uid, oldKey: key, auth });
            } else if (store && typeof store.save === "function") {
              await store.save({ newAt, newRt, uid, oldKey: key, auth });
            } else if (store && Array.isArray(store.keys) && Array.isArray(store.authList)) {
              await applyTokenRefresh({
                uid,
                oldKey: key,
                newToken: newAt,
                refreshToken: newRt,
                domain: auth.domain || "www.codebuddy.cn",
                enterpriseId: auth.enterpriseId || "",
                auth,
                keys: store.keys,
                authList: store.authList,
                file: file || undefined,
              });
            }
          } catch (err) {
            console.error(`[workbuddy] token 落盘失败（刷新已成功，重启将丢失）: ${String(err?.message || err).slice(0, 200)}`);
          }
          return newAt;
        }
      } catch {}
      return null;
    })();
    inflightRefresh.set(dedupKey, p);
    try {
      const r = await p;
      return r;
    } finally {
      inflightRefresh.delete(dedupKey);
    }
  }

  function maybeProactiveRefresh(auth, key) {
    try {
      const exp = decodeJwtExp(key);
      if (!exp) return;
      const remain = exp * 1000 - clock();
      if (remain < 5 * 60 * 1000 && remain > -60 * 60 * 1000) {
        void refreshTokenFor(key, auth).catch(() => {});
      }
    } catch {}
  }

  return { refreshTokenFor, maybeProactiveRefresh, decodeJwtExp, isAuthError, isInsufficientStatus, _inflight: inflightRefresh };
}
