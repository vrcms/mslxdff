import { joinUrl } from "../base.js";
import { isAuthError, isInsufficientStatus } from "./auth.js";
import { appendRotationLog as defaultAppend } from "./rotation-log.js";
import { createTransport } from "../../transport/index.js";

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
  h["X-Domain"] = auth?.domain || "www.codebuddy.cn";
  if (auth?.enterpriseId) { h["X-Enterprise-Id"] = auth.enterpriseId; h["X-Tenant-Id"] = auth.enterpriseId; }
  return h;
}

function withUidHeader(res, uid) {
  try { res.headers.set("x-mslxdff-workbuddy-uid", uid); return res; }
  catch {
    try {
      const h = new Headers(res.headers);
      h.set("x-mslxdff-workbuddy-uid", uid);
      const c = new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
      c._t = res._t;
      return c;
    } catch { return res; }
  }
}

function nowMs(clock) { return typeof performance !== "undefined" && performance.now ? performance.now() : clock(); }

function errRes(status, msg, reason, uid, t0, clock) {
  const r = new Response(JSON.stringify({ error: msg }), { status, headers: { "Content-Type": "application/json", "x-mslxdff-workbuddy-reason": reason, "x-mslxdff-workbuddy-uid": uid } });
  r._t = { attempts: [], waitMs: 0, totalMs: Math.round(nowMs(clock) - t0) };
  return r;
}

function failErr(msg, t0, clock, extra) {
  const e = new Error(msg);
  e._t = { attempts: [], waitMs: 0, totalMs: Math.round(nowMs(clock) - t0), ...(extra || {}) };
  return e;
}

export function createChatService({
  id = "workbuddy",
  baseUrl,
  chatPath,
  keys,
  authList,
  ring,
  fetchImpl,
  dispatcher,
  connectTimeoutMs = 30_000,
  balanceCache,
  authService,
  logger,
  clock = Date.now,
  cooldownMs = 30_000,
} = {}) {
  const getBalance = balanceCache?.getCachedBalance || (() => null);
  const setBalance = balanceCache?.setCachedBalance || (() => {});
  const doLog = (opts) => {
    if (logger && typeof logger.append === "function") { try { logger.append(opts); } catch {} return; }
    if (logger && typeof logger.log === "function") { try { logger.log(opts); } catch {} return; }
    try { defaultAppend(opts); } catch {}
  };
  const transport = createTransport({ fetchImpl, dispatcher, keepAlive: !!dispatcher, timeoutMs: connectTimeoutMs, retry: {} });

  function authForKey(key) {
    const idx = keys.indexOf(key);
    if (idx >= 0 && authList[idx]) return authList[idx];
    if (authList.length) return authList[0];
    return { uid: "", domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "" };
  }

  async function fetchOnce(url, body, key, auth) {
    return transport.request({ url, headers: buildAuthHeaders(key, auth), body: { ...body, stream: true }, stream: true });
  }

  async function withRefresh(url, body, key, auth) {
    let res;
    try { res = await fetchOnce(url, body, key, auth); }
    catch (e) { throw e; }
    if (res.status < 400) return res;
    let txt = "";
    try { txt = await res.text(); } catch {}
    if (!isAuthError(res.status, txt)) return res;
    const newKey = await authService?.refreshTokenFor?.(key, auth);
    if (!newKey) throw failErr(`workbuddy refresh failed for ${auth?.uid || ""}: ${txt.slice(0, 120)}`, _t0(), clock);
    const auth2 = authForKey(newKey);
    let res2;
    try { res2 = await fetchOnce(url, body, newKey, auth2); }
    catch (e2) { throw e2; }
    let stillTxt = "";
    if (res2.status >= 400) { try { stillTxt = await res2.text(); } catch {} }
    const stillAuth = isAuthError(res2.status, stillTxt);
    const uid2 = auth2.uid || auth.uid;
    res2 = withUidHeader(res2, uid2);
    res2._t = res2._t || { attempts: [], waitMs: 0, totalMs: Math.round(nowMs(clock) - _t0()) };
    if (stillAuth || res2.status === 429 || res2.status >= 500) try { ring.onError(newKey); } catch {}
    doLog({ uid: uid2, model: _modelForLog(), totalMs: Math.round(nowMs(clock) - _t0()), balanceHit: false, error: stillAuth ? `still auth ${res2.status}` : undefined });
    if (stillAuth) throw failErr(`workbuddy auth still failing after refresh for ${uid2}: ${stillTxt.slice(0, 120)}`, _t0(), clock);
    return res2;
  }

  let _t0Val = 0;
  let _modelVal = "";
  function _t0() { return _t0Val; }
  function _modelForLog() { return _modelVal; }

  async function runChat(body, activeRing, opts = {}) {
    const url = joinUrl(baseUrl, chatPath);
    const t0 = nowMs(clock);
    _t0Val = t0;
    _modelVal = body?.model || "";
    const preferredUid = opts?.workbuddyUid ? String(opts.workbuddyUid).trim() : "";

    if (preferredUid) {
      const idx = authList.findIndex((a) => a.uid === preferredUid || String(a.uid).startsWith(preferredUid));
      if (idx < 0) return errRes(403, `workbuddy uid not found: ${preferredUid}`, "uid-not-found", preferredUid, t0, clock);
      const key = keys[idx];
      const auth = authList[idx];
      authService?.maybeProactiveRefresh?.(auth, key);
      const cached = getBalance(auth.uid);
      if (cached && Number(cached.total) === 0) return errRes(403, `workbuddy uid in cooldown (balance 0): ${auth.uid}`, "uid-cooling", auth.uid, t0, clock);
      try {
        let res = await withRefresh(url, body, key, auth);
        res = withUidHeader(res, auth.uid);
        res._t = res._t || { attempts: [], waitMs: 0, totalMs: Math.round(nowMs(clock) - t0) };
        if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) try { activeRing.onError(key); } catch {}
        doLog({ uid: auth.uid, model: _modelVal, totalMs: Math.round(nowMs(clock) - t0), balanceHit: false });
        return res;
      } catch (e) {
        e._t = e._t || { attempts: [], waitMs: 0, totalMs: Math.round(nowMs(clock) - t0) };
        if (!(e instanceof Error) || !String(e.message).includes("refresh failed")) try { activeRing.onError(key); } catch {}
        throw e;
      }
    }

    const tried = new Set();
    const maxTries = Math.max(1, keys.length);
    let lastErr = null;
    for (let triedCount = 0; triedCount < maxTries; triedCount++) {
      const key = activeRing.next();
      if (!key) {
        if (triedCount === 0) throw failErr(`${id}: all API keys are in cooldown (last error < ${cooldownMs}ms ago) — provider temporarily unavailable`, t0, clock, { cooldownMs });
        break;
      }
      const auth = authForKey(key);
      const uid = auth?.uid || "";
      if (tried.has(uid || key)) continue;
      tried.add(uid || key);
      const cached = uid ? getBalance(uid) : null;
      if (cached && Number(cached.total) === 0) {
        try { activeRing.onError(key); } catch {}
        setBalance(uid, { ...cached, total: 0 });
        doLog({ uid, model: _modelVal, totalMs: Math.round(nowMs(clock) - t0), balanceHit: true });
        if (keys.length === 1 || activeRing.available() === 0) return errRes(403, `workbuddy uid in cooldown (balance 0): ${uid}`, "uid-cooling", uid, t0, clock);
        continue;
      }
      if (!key && activeRing.size === 0) throw failErr(`${id}: missing MSLXDFF_WORKBUDDY_KEY (chat requires a real key) — run node workbuddy-token-auto.js`, t0, clock);
      authService?.maybeProactiveRefresh?.(auth, key);
      let res;
      try { res = await withRefresh(url, body, key, auth); }
      catch (e) {
        e._t = e._t || { attempts: [], waitMs: 0, totalMs: Math.round(nowMs(clock) - t0) };
        try { activeRing.onError(key); } catch {}
        lastErr = e;
        continue;
      }
      if (res.status === 402 || res.status === 403 || res.status === 429) {
        let txt = "";
        try { txt = await res.text(); } catch {}
        if (isInsufficientStatus(res.status, txt, cached)) {
          try { activeRing.onError(key); } catch {}
          if (uid) setBalance(uid, { total: 0, dailyPacks: 0, activeCount: 0, nextExpire: null, fetchedAt: clock() });
          doLog({ uid, model: _modelVal, totalMs: Math.round(nowMs(clock) - t0), balanceHit: true, error: txt.slice(0, 120) });
          lastErr = failErr(`workbuddy insufficient for ${uid}: ${txt.slice(0, 120)}`, t0, clock);
          continue;
        }
      }
      if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) try { activeRing.onError(key); } catch {}
      res = withUidHeader(res, uid);
      res._t = res._t || { attempts: [], waitMs: 0, totalMs: Math.round(nowMs(clock) - t0) };
      doLog({ uid, model: _modelVal, totalMs: Math.round(nowMs(clock) - t0), balanceHit: false });
      return res;
    }
    if (lastErr) throw lastErr;
    throw failErr(`${id}: all workbuddy accounts exhausted or unavailable`, t0, clock);
  }

  return { runChat, authForKey, buildAuthHeaders, withUidHeader, attemptOnce: fetchOnce };
}
