import { joinUrl, sleep } from "../base.js";
import { compatFetch } from "../../compat.js";

/**
 * Cline Token 池：多账号 round-robin + refresh 换 accessToken + 冷却 + 队列
 * 对标 pingmike2/cline2api-workers 的 accounts / getAccountToken / parseCooldown / enqueue
 */

export function parseCooldown(body, status) {
  const m = String(body || "").match(/try again in (?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i);
  if (m) {
    const h = parseInt(m[1] || 0, 10);
    const min = parseInt(m[2] || 0, 10);
    const s = parseInt(m[3] || 0, 10);
    const ms = (h * 3600 + min * 60 + s) * 1000;
    if (ms > 0) return Math.min(ms, 6 * 3600 * 1000);
  }
  if (status === 429) return 5 * 60 * 1000;
  return 60 * 1000;
}

/**
 * 真死 vs 假死：对标官方 getValidClineCredentials 契约——只有 invalid_grant
 *（refresh token 被拒）才判死，需重新授权；网络抖动/5xx/超时是瞬时失败，
 * 手里 token 仍有效时继续用，且绝不清掉已存凭证。
 */
export function isInvalidGrant(bodyText, status) {
  const t = String(bodyText || "").toLowerCase();
  if (/invalid_grant|invalid_token/.test(t)) return true;
  // 路由拼错/版本提示类 401（"...latest version...re-authenticate your Cline account"）
  // 只是打错了地址，不是 token 死，绝不能判死，否则好号会被永久冷冻。
  if (/latest version|re-authenticate/.test(t)) return false;
  if ((status === 400 || status === 403) && /invalid|expired|revoked/.test(t)) return true;
  if (status === 401 && /invalid_grant|invalid token|token[^.]{0,30}(expired|revoked|invalid)/.test(t)) return true;
  return false;
}

/**
 * 一次性 refresh：bench/诊断用，不落盘、不建池。
 * 返回 accessToken 或 null。
 */
export async function refreshTokenForBase({ refreshToken, baseUrl = "https://api.cline.bot", fetchImpl = compatFetch, dispatcher } = {}) {
  const rt = String(refreshToken || "").trim();
  if (!rt) return null;
  const resolvedBase = String(baseUrl).trim().replace(/\/+$/, "") || "https://api.cline.bot";
  const baseNoV1 = resolvedBase.endsWith("/api/v1") ? resolvedBase.slice(0, -7) : resolvedBase;
  const url = joinUrl(baseNoV1, "/api/v1/auth/refresh");
  const opts = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: rt, grantType: "refresh_token" }),
  };
  if (dispatcher) opts.dispatcher = dispatcher;
  try {
    const res = await fetchImpl(url, opts);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.accessToken || data?.accessToken || data?.access_token || null;
  } catch {
    return null;
  }
}

export function createAuthPool({
  id = "cline",
  keys = [],
  fetchImpl,
  dispatcher,
  baseUrl = "https://api.cline.bot",
  file,
  clock = Date.now,
  saveFn,
} = {}) {
  const resolvedBase = String(baseUrl).trim().replace(/\/+$/, "") || "https://api.cline.bot";
  let accounts = [];
  let accountIndex = 0;
  let currentAccount = null;
  let queueTail = Promise.resolve();
  const MIN_GAP_MS = 800;

  function parseAccounts(tokens) {
    const list = [...new Set((tokens || []).map((s) => String(s).trim()).filter((s) => s.length > 8))];
    if (list.length === 0) {
      accounts = [];
      return accounts;
    }
    const changed = accounts.length !== list.length || accounts.some((a, i) => a.refreshToken !== list[i]);
    if (changed) {
      accounts = list.map((rt) => ({ refreshToken: rt, accessToken: null, expiry: 0, cooldownUntil: 0 }));
      accountIndex = 0;
    }
    return accounts;
  }

  // 初始解析
  parseAccounts(keys);

  function enqueue(fn) {
    const run = queueTail.then(() => sleep(MIN_GAP_MS)).then(fn);
    queueTail = run.catch(() => {});
    return run;
  }

  function pickAccount(pool) {
    const list = pool || accounts;
    for (let k = 0; k < list.length; k++) {
      const acc = list[accountIndex % list.length];
      accountIndex = (accountIndex + 1) % list.length;
      if (acc.dead) continue;
      if (!acc.cooldownUntil || acc.cooldownUntil <= clock()) {
        currentAccount = acc;
        return acc;
      }
    }
    return null;
  }

  async function refreshOne(account) {
    const now = clock();
    if (account.dead) throw new Error("invalid_grant");
    if (account.cooldownUntil > now) throw new Error("account_cooldown");
    if (account.accessToken && now < account.expiry) return account.accessToken;
    // base 可能已含 /api/v1（state 里 clinebot baseUrl 就是 …/api/v1），直接拼会 double 成
    // …/api/v1/api/v1/auth/refresh → 上游回 401 Unauthorized（版本/重认证提示），绝不能当 token 死。
    const baseNoV1 = resolvedBase.replace(/\/api\/v1\/?$/, "");
    const url = joinUrl(baseNoV1, "/api/v1/auth/refresh");
    const opts = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: account.refreshToken, grantType: "refresh_token" }),
    };
    if (dispatcher) opts.dispatcher = dispatcher;
    let res;
    try { res = await fetchImpl(url, opts); } catch { account.cooldownUntil = now + 60 * 1000; throw new Error("refresh_failed"); }
    if (!res.ok) {
      let t = "";
      try { t = await res.text(); } catch {}
      if (isInvalidGrant(t, res.status)) { account.dead = true; throw new Error("invalid_grant"); }
      account.cooldownUntil = now + 60 * 1000; throw new Error("refresh_failed");
    }
    let data;
    try { data = await res.json(); } catch { account.cooldownUntil = now + 60 * 1000; throw new Error("refresh_no_token"); }
    const accessToken = data?.data?.accessToken || data?.accessToken || data?.access_token;
    if (!accessToken) { account.cooldownUntil = now + 60 * 1000; throw new Error("refresh_no_token"); }
    const newRt = typeof data?.data?.refreshToken === "string" && data.data.refreshToken.trim() ? data.data.refreshToken.trim() : null;
    if (newRt && newRt !== account.refreshToken) {
      const oldRt = account.refreshToken;
      account.refreshToken = newRt;
      if (saveFn) {
        try { await saveFn({ oldRefreshToken: oldRt, newRefreshToken: newRt, newAccessToken: accessToken }); } catch {}
      }
    }
    account.accessToken = accessToken;
    const expiresAt = data?.data?.expiresAt ?? data?.expiresAt;
    let expiry = now + 10 * 60 * 1000;
    if (typeof expiresAt === "number") expiry = expiresAt;
    else if (typeof expiresAt === "string") { const t = Date.parse(expiresAt); if (!isNaN(t)) expiry = t; }
    account.expiry = expiry - 60 * 1000;
    return accessToken;
  }

  async function getAccessToken() {
    const pool = accounts;
    if (pool.length === 0) throw new Error("缺少 CLINE_REFRESH_TOKEN（请用 cline_oauth.py 获取）");
    for (let attempt = 0; attempt < pool.length; attempt++) {
      const acc = pool[attempt % pool.length];
      if (acc.dead) continue;
      if (acc.cooldownUntil && acc.cooldownUntil > clock()) continue;
      currentAccount = acc;
      try { return await refreshOne(acc); } catch (e) { if (e.message === "account_cooldown") continue; continue; }
    }
    const acc = pool.find((a) => !a.dead) || null;
    if (!acc) throw new Error("无可用 Cline 账号");
    currentAccount = acc;
    acc.cooldownUntil = 0;
    return refreshOne(acc);
  }

  function getCurrentAccount() { return currentAccount; }
  function getAccounts() { return accounts; }
  function updateKeys(newKeys) { parseAccounts(newKeys); }

  return { parseAccounts, getAccessToken, refreshOne, pickAccount, parseCooldown, enqueue, getCurrentAccount, getAccounts, updateKeys, _accounts: () => accounts };
}
