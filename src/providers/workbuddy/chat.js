import { joinUrl } from "../base.js";
import { isAuthError, isInsufficientStatus } from "./auth.js";
import { appendRotationLog as defaultAppend } from "./rotation-log.js";

function buildAuthHeaders(key, auth) {
  const h = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": "CLI/2.115.0 WorkBuddy/2.115.0",
    Origin: "https://www.codebuddy.cn",
    Referer: "https://www.codebuddy.cn/",
    "X-Product": "SaaS",
  };
  if (key) h["Authorization"] = `Bearer ${key}`;
  if (auth?.uid) h["X-User-Id"] = auth.uid;
  if (auth?.domain) h["X-Domain"] = auth.domain;
  else h["X-Domain"] = "www.codebuddy.cn";
  if (auth?.enterpriseId) {
    h["X-Enterprise-Id"] = auth.enterpriseId;
    h["X-Tenant-Id"] = auth.enterpriseId;
  }
  return h;
}

function withUidHeader(res, uid) {
  try {
    res.headers.set("x-mslxdff-workbuddy-uid", uid);
    return res;
  } catch {
    try {
      const h = new Headers(res.headers);
      h.set("x-mslxdff-workbuddy-uid", uid);
      const clone = new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
      clone._t = res._t;
      return clone;
    } catch {
      return res;
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function createChatService({
  id = "workbuddy",
  baseUrl,
  chatPath,
  keys, // mutable array ref
  authList, // mutable array ref
  ring, // keyRing instance for auto mode
  fetchImpl,
  dispatcher,
  connectTimeoutMs = 30_000,
  retry = {
    network: { attempts: 2, delayMs: 300 },
    429: { attempts: 1, delayMs: 100 },
    502: { attempts: 1, delayMs: 100 },
    503: { attempts: 1, delayMs: 100 },
    504: { attempts: 1, delayMs: 100 },
  },
  balanceCache, // { getCachedBalance, setCachedBalance }
  authService, // { refreshTokenFor, maybeProactiveRefresh }
  logger, // { append } or null
  clock = Date.now,
  cooldownMs = 30_000,
} = {}) {
  const getBalance = balanceCache?.getCachedBalance || (() => null);
  const setBalance = balanceCache?.setCachedBalance || (() => {});
  const doLog = (opts) => {
    if (logger && typeof logger.append === "function") {
      try { logger.append(opts); } catch {}
      return;
    }
    if (logger && typeof logger.log === "function") {
      try { logger.log(opts); } catch {}
      return;
    }
    // fallback to default append (may write to fs; test passes noop logger so not called)
    try { defaultAppend(opts); } catch {}
  };

  function authForKey(key) {
    const idx = keys.indexOf(key);
    if (idx >= 0 && authList[idx]) return authList[idx];
    if (authList.length) return authList[0];
    return { uid: "", domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "" };
  }

  async function attemptOnce(url, body, key) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${id} timed out after ${connectTimeoutMs}ms`)), connectTimeoutMs);
    try {
      const auth = authForKey(key);
      const headers = buildAuthHeaders(key, auth);
      const finalBody = { ...body, stream: true };
      const opts = { method: "POST", headers, body: JSON.stringify(finalBody), signal: controller.signal };
      if (dispatcher) opts.dispatcher = dispatcher;
      const res = await fetchImpl(url, opts);
      return res;
    } catch (err) {
      return err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function runChat(body, activeRing, opts = {}) {
    const url = joinUrl(baseUrl, chatPath);
    const t0 = typeof performance !== "undefined" && performance.now ? performance.now() : clock();
    const preferredUid = opts?.workbuddyUid ? String(opts.workbuddyUid).trim() : "";
    const modelForLog = body?.model || "";

    if (preferredUid) {
      const idx = authList.findIndex(a => a.uid === preferredUid || a.uid.startsWith(preferredUid));
      if (idx < 0) {
        const errBody = JSON.stringify({ error: `workbuddy uid not found: ${preferredUid}` });
        const res = new Response(errBody, { status: 403, headers: { "Content-Type": "application/json", "x-mslxdff-workbuddy-reason": "uid-not-found", "x-mslxdff-workbuddy-uid": preferredUid } });
        res._t = { attempts: [], waitMs: 0, totalMs: Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : clock()) - t0) };
        return res;
      }
      const key = keys[idx];
      const auth = authList[idx];
      authService?.maybeProactiveRefresh?.(auth, key);
      const cached = getBalance(auth.uid);
      if (cached && Number(cached.total) === 0) {
        const errBody = JSON.stringify({ error: `workbuddy uid in cooldown (balance 0): ${auth.uid}` });
        const res = new Response(errBody, { status: 403, headers: { "Content-Type": "application/json", "x-mslxdff-workbuddy-reason": "uid-cooling", "x-mslxdff-workbuddy-uid": auth.uid } });
        res._t = { attempts: [], waitMs: 0, totalMs: Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : clock()) - t0) };
        return res;
      }
      const attempts = [];
      let waitMs = 0;
      for (let attempt = 0; ; attempt++) {
        const t = typeof performance !== "undefined" && performance.now ? performance.now() : clock();
        let result = await attemptOnce(url, body, key);
        const type = result instanceof Error ? "network" : `http${result?.status}`;
        attempts.push({ attempt, type, ms: Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : clock()) - t) });
        if (result instanceof Error) {
          const entry = retry?.network;
          if (entry && attempt < entry.attempts) { await sleep(entry.delayMs); waitMs += entry.delayMs; continue; }
          activeRing.onError(key);
          result._t = { attempts, waitMs, totalMs: Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : clock()) - t0) };
          throw result;
        }
        if (attempt === 0) {
          let bodyText = "";
          try { bodyText = await result.clone().text(); } catch {}
          if (isAuthError(result.status, bodyText)) {
            const newKey = await authService?.refreshTokenFor?.(key, auth);
            if (newKey) {
              const auth2 = authForKey(newKey);
              const headers2 = buildAuthHeaders(newKey, auth2);
              const finalBody = { ...body, stream: true };
              const controller2 = new AbortController();
              const timer2 = setTimeout(() => controller2.abort(new Error(`${id} timed out after ${connectTimeoutMs}ms`)), connectTimeoutMs);
              try {
                const opts2 = { method: "POST", headers: headers2, body: JSON.stringify(finalBody), signal: controller2.signal };
                if (dispatcher) opts2.dispatcher = dispatcher;
                let res2 = await fetchImpl(url, opts2);
                let res2Body = "";
                try { res2Body = await res2.clone().text(); } catch {}
                const stillAuth = isAuthError(res2.status, res2Body);
                res2._t = { attempts, waitMs, totalMs: Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : clock()) - t0), refreshed: true };
                res2 = withUidHeader(res2, auth2.uid || auth.uid);
                if (stillAuth || res2.status === 429 || res2.status >= 500) activeRing.onError(newKey);
                doLog({ uid: auth2.uid || auth.uid, model: modelForLog, totalMs: Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : clock()) - t0), balanceHit: false, error: stillAuth ? `still auth ${res2.status}` : undefined });
                return res2;
              } catch (e2) { e2._t = { attempts, waitMs, totalMs: Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : clock()) - t0) }; throw e2; } finally { clearTimeout(timer2); }
            }
          }
        }
        const entry = retry?.[result.status];
        if (entry && attempt < entry.attempts) { await sleep(entry.delayMs); waitMs += entry.delayMs; continue; }
        if (result.status === 401 || result.status === 403 || result.status === 429 || result.status >= 500) activeRing.onError(key);
        result = withUidHeader(result, auth.uid);
        result._t = { attempts, waitMs, totalMs: Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : clock()) - t0) };
        doLog({ uid: auth.uid, model: modelForLog, totalMs: Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : clock()) - t0), balanceHit: false });
        return result;
      }
    }

    // auto rotation
    const attempts = [];
    let waitMs = 0;
    let lastErr = null;
    const tried = new Set();
    const maxTries = Math.max(1, keys.length);
    for (let triedCount = 0; triedCount < maxTries; triedCount++) {
      const key = activeRing.next();
      if (!key) {
        if (triedCount === 0) {
          const err = new Error(`${id}: all API keys are in cooldown (last error < ${cooldownMs}ms ago) — provider temporarily unavailable`);
          err._t = { attempts, waitMs, totalMs: Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : clock()) - t0), cooldownMs };
          throw err;
        }
        break;
      }
      const auth = authForKey(key);
      const uid = auth?.uid || "";
      if (tried.has(uid || key)) continue;
      tried.add(uid || key);
      const cached = uid ? getBalance(uid) : null;
      if (cached && Number(cached.total) === 0) {
        activeRing.onError(key);
        setBalance(uid, { ...cached, total: 0 });
        doLog({ uid, model: modelForLog, totalMs: Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : clock()) - t0), balanceHit: true });
        // 单号余额为 0 直接返回 403，避免抛“exhausted”让调用方误判为 500
        if (keys.length === 1 || activeRing.available() === 0) {
          const errBody = JSON.stringify({ error: `workbuddy uid in cooldown (balance 0): ${uid}` });
          const res = new Response(errBody, { status: 403, headers: { "Content-Type": "application/json", "x-mslxdff-workbuddy-reason": "uid-cooling", "x-mslxdff-workbuddy-uid": uid } });
          res._t = { attempts, waitMs, totalMs: Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : clock()) - t0) };
          return res;
        }
        continue;
      }
      if (!key && activeRing.size === 0) {
        const err = new Error(`${id}: missing MSLXDFF_WORKBUDDY_KEY (chat requires a real key) — run node workbuddy-token-auto.js`);
        err._t = { attempts, waitMs, totalMs: Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : clock()) - t0) };
        throw err;
      }
      authService?.maybeProactiveRefresh?.(auth, key);
      let result = null;
      let attempt = 0;
      for (; ; attempt++) {
        const t = typeof performance !== "undefined" && performance.now ? performance.now() : clock();
        result = await attemptOnce(url, body, key);
        const type = result instanceof Error ? "network" : `http${result?.status}`;
        attempts.push({ attempt: triedCount * 10 + attempt, type, ms: Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : clock()) - t), uid });
        if (result instanceof Error) {
          const entry = retry?.network;
          if (entry && attempt < entry.attempts) { await sleep(entry.delayMs); waitMs += entry.delayMs; continue; }
          activeRing.onError(key);
          lastErr = result;
          result._t = { attempts, waitMs, totalMs: Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : clock()) - t0) };
          break;
        }
        if (attempt === 0) {
          let bodyText = "";
          try { bodyText = await result.clone().text(); } catch {}
          const needRefresh = isAuthError(result.status, bodyText);
          if (needRefresh) {
            const newKey = await authService?.refreshTokenFor?.(key, auth);
            if (newKey) {
              const auth2 = authForKey(newKey);
              const headers2 = buildAuthHeaders(newKey, auth2);
              const finalBody = { ...body, stream: true };
              const controller2 = new AbortController();
              const timer2 = setTimeout(() => controller2.abort(new Error(`${id} timed out after ${connectTimeoutMs}ms`)), connectTimeoutMs);
              try {
                const opts2 = { method: "POST", headers: headers2, body: JSON.stringify(finalBody), signal: controller2.signal };
                if (dispatcher) opts2.dispatcher = dispatcher;
                let res2 = await fetchImpl(url, opts2);
                let res2Body = "";
                try { res2Body = await res2.clone().text(); } catch {}
                const stillAuth = isAuthError(res2.status, res2Body);
                res2._t = { attempts, waitMs, totalMs: Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : clock()) - t0), refreshed: true };
                res2 = withUidHeader(res2, auth2.uid || uid);
                if (stillAuth || res2.status === 429 || res2.status >= 500) activeRing.onError(newKey);
                doLog({ uid: auth2.uid || uid, model: modelForLog, totalMs: Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : clock()) - t0), balanceHit: false, error: stillAuth ? `still auth ${res2.status}` : undefined });
                if (stillAuth) {
                  lastErr = new Error(`workbuddy auth still failing after refresh for ${uid}: ${res2Body.slice(0, 120)}`);
                  lastErr._t = res2._t;
                  activeRing.onError(newKey);
                  break;
                }
                return res2;
              } catch (e2) { e2._t = { attempts, waitMs, totalMs: Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : clock()) - t0) }; lastErr = e2; break; } finally { clearTimeout(timer2); }
            } else {
              lastErr = new Error(`workbuddy refresh failed for ${uid}: ${bodyText.slice(0, 120)}`);
              lastErr._t = { attempts, waitMs, totalMs: Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : clock()) - t0) };
              activeRing.onError(key);
              break;
            }
          }
        }
        const entry = retry?.[result.status];
        if (entry && attempt < entry.attempts) { await sleep(entry.delayMs); waitMs += entry.delayMs; continue; }
        break;
      }
      if (result instanceof Error) {
        continue;
      }
      let bodyText = "";
      let isInsuff = false;
      if (result.status === 402 || result.status === 403 || result.status === 429) {
        try { bodyText = await result.clone().text(); } catch { try { bodyText = await result.text(); } catch { bodyText = ""; } }
        isInsuff = isInsufficientStatus(result.status, bodyText, cached);
      }
      if (isInsuff) {
        activeRing.onError(key);
        if (uid) setBalance(uid, { total: 0, dailyPacks: 0, activeCount: 0, nextExpire: null, fetchedAt: clock() });
        doLog({ uid, model: modelForLog, totalMs: Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : clock()) - t0), balanceHit: true, error: bodyText.slice(0, 120) });
        lastErr = new Error(`workbuddy insufficient for ${uid}: ${bodyText.slice(0, 120)}`);
        lastErr._t = { attempts, waitMs, totalMs: Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : clock()) - t0) };
        continue;
      }
      if (result.status === 401 || result.status === 403 || result.status === 429 || result.status >= 500) activeRing.onError(key);
      result = withUidHeader(result, uid);
      result._t = { attempts, waitMs, totalMs: Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : clock()) - t0) };
      doLog({ uid, model: modelForLog, totalMs: Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : clock()) - t0), balanceHit: false });
      return result;
    }
    if (lastErr) throw lastErr;
    const err = new Error(`${id}: all workbuddy accounts exhausted or unavailable`);
    err._t = { attempts, waitMs, totalMs: Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : clock()) - t0) };
    throw err;
  }

  return { runChat, authForKey, buildAuthHeaders, withUidHeader, attemptOnce };
}
