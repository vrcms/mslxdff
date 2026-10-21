import { joinUrl, envInt } from "../base.js";
import { isAuthError, isInsufficientStatus, isRateLimitedStatus, parseRateLimitResetMs, isAccountRestricted } from "./auth.js";
import { appendRotationLog as defaultAppend } from "./rotation-log.js";
import { createTransport } from "../../transport/index.js";
import { dispatcherFetch } from "../../upstream-engine/sdk/attempt.js";
import { reshapeWorkbuddySse } from "./reshape.js";
import { attemptOnceSdk } from "./sdk-chat.js";
import { sanitizeToolSequence } from "./sanitize-tools.js";
import { rewriteWorkbuddyPayload } from "./payload.js";
import { resolveEngineMode } from "../../upstream-engine/mode.js";
import { buildWorkbuddyHeaders } from "./client-headers.js";

// 出站指纹单一真值：官方桌面端口径见 client-headers.js（含每请求随机 conversation/trace id）。
// 真机 chat 的 Accept 是 application/json（SSE 由 body.stream 协商、非 Accept），故不传 accept 用默认值。
function buildAuthHeaders(key, auth) {
  return buildWorkbuddyHeaders(key, auth);
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

// 400 判型需读 body 文本；读过的 Response body 不可再读（下游转发报 "Body is unusable"），
// 用文本重建一个等价响应（去掉 content-length 防长度不符）。
function rewrapBody(res, txt) {
  try { console.error(`[workbuddy] upstream ${res.status} body: ${String(txt).slice(0, 300)}`); } catch {}
  try {
    const h = new Headers(res.headers);
    h.delete("content-length");
    const r = new Response(txt, { status: res.status, statusText: res.statusText, headers: h });
    try { r._t = res._t; } catch {}
    return r;
  } catch { return res; }
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
  // 封号 11140 冷却时长（env MSLXDFF_WORKBUDDY_RESTRICTED_COOLDOWN_MS，缺省 15min）：
  // 腾讯"异常行为"限制可长可短，30s 档太短会反复白烧；15min 内人工申诉/自动解封后再回来。
  const restrictedCooldownMs = envInt("MSLXDFF_WORKBUDDY_RESTRICTED_COOLDOWN_MS", 900_000);
  // 最近一次「账号封禁 11140」记账 { at, uids, message }——让冷却期内到达的请求如实回 403
  // （旧表现：keyring 全冷却 → 笼统 "all API keys are in cooldown" 冒 502，用户/客户端看不出是封号）。
  let lastRestricted = null;
  const getBalance = balanceCache?.getCachedBalance || (() => null);
  const setBalance = balanceCache?.setCachedBalance || (() => {});
  const doLog = (opts) => {
    if (logger && typeof logger.append === "function") { try { logger.append(opts); } catch {} return; }
    if (logger && typeof logger.log === "function") { try { logger.log(opts); } catch {} return; }
    try { defaultAppend(opts); } catch {}
  };
  const transport = createTransport({ fetchImpl, dispatcher, keepAlive: !!dispatcher, timeoutMs: connectTimeoutMs, retry: {} });
  // SDK 通道与 legacy 同享 keep-alive 连接池（dispatcher → fetch 注入）；同时该 fetch 被 attempt 层
  // 包装用于错误路径捕获请求体（上游 4xx 时打印 tool 序列断裂诊断，见 sdk/attempt.js）。
  const sdkFetch = dispatcher ? dispatcherFetch(dispatcher) : fetchImpl;

  function authForKey(key) {
    const idx = keys.indexOf(key);
    if (idx >= 0 && authList[idx]) return authList[idx];
    if (authList.length) return authList[0];
    return { uid: "", domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "" };
  }

  // SDK 通道（缺省启用）：缺省底层走 @ai-sdk/openai-compatible，`legacy`/关闭词
  // （局部 MSLXDFF_WORKBUDDY_SDK，未设则继承全局 MSLXDFF_UPSTREAM_ENGINE）回退原生 transport；
  // 不可用（未安装）自动回退并告警一次。上层轮换/刷新/reshape 全链复用。
  // Note: 为什么默认 SDK、翻译层代价与回退语义 — 见 .agents/notes/implemented/feature/2026-09-12-workbuddy-sdk-channel.md
  // 上游非标字段（thinking / reasoning_effort / reasoning_content / tool_choice 字符串）不依赖 SDK 白名单：
  // payload.js 前置语义改写 + AI SDK providerOptions 透传（非白名单 key 原样 spread 进 body，2.0.41 实测）。
  // 序列化/流式/错误映射仍全部交 AI SDK；原生 transport 仅作 SDK 不可用时的回退。v0.1.120 实测见 .scratch/probe-sdk-body.mjs。
  const engineMode = resolveEngineMode(process.env, "MSLXDFF_WORKBUDDY_SDK", "sdk");
  let sdkFallbackLogged = false;
  async function fetchOnce(url, body, key, auth) {
    const payload = rewriteWorkbuddyPayload(body);
    if (engineMode === "sdk") {
      try {
        return await attemptOnceSdk({ url, body: payload, key, auth, buildHeaders: buildAuthHeaders, ...(sdkFetch ? { fetchImpl: sdkFetch } : {}) });
      } catch (e) {
        if (!e || !e._sdkLoadFailed) throw e;
        if (!sdkFallbackLogged) {
          sdkFallbackLogged = true;
          try { console.error(`[workbuddy] ${e.message} — 回退原生通道`); } catch {}
        }
      }
    }
    return transport.request({ url, headers: buildAuthHeaders(key, auth), body: { ...payload, stream: true }, stream: true });
  }

  async function withRefresh(url, body, key, auth) {
    let res;
    try { res = await fetchOnce(url, body, key, auth); }
    catch (e) { throw e; }
    if (res.status < 400) return reshapeWorkbuddySse(res);
    let txt = "";
    try { txt = await res.text(); } catch {}
    // 账号封禁 11140：判账号本体，refresh 无效（2026-10-21 实测刷出新 token 照样 11140），
    // 原样上抛让 runChat 走「长冷却 + 换号」，绝不进 refresh 连锁白烧上游。
    if (isAccountRestricted(res.status, txt)) {
      throw failErr(`workbuddy account restricted (11140) for ${auth?.uid || ""}: ${txt.slice(0, 160)}`, _t0(), clock, { restricted: true, status: res.status });
    }
    if (!isAuthError(res.status, txt)) return rewrapBody(res, txt);
    const newKey = await authService?.refreshTokenFor?.(key, auth);
    if (!newKey) throw failErr(`workbuddy refresh failed for ${auth?.uid || ""}: ${txt.slice(0, 120)}`, _t0(), clock);
    const auth2 = authForKey(newKey);
    let res2;
    try { res2 = await fetchOnce(url, body, newKey, auth2); }
    catch (e2) { throw e2; }
    let stillTxt = "";
    if (res2.status >= 400) { try { stillTxt = await res2.text(); } catch {} }
    // 刷新后仍被封：同属账号级限制，标记 restricted 供上层长冷却。
    if (isAccountRestricted(res2.status, stillTxt)) {
      throw failErr(`workbuddy account restricted (11140) for ${auth?.uid || ""}: ${stillTxt.slice(0, 160)}`, _t0(), clock, { restricted: true, status: res2.status });
    }
    if (stillTxt) res2 = rewrapBody(res2, stillTxt);
    const stillAuth = isAuthError(res2.status, stillTxt);
    const uid2 = auth2.uid || auth.uid;
    res2 = withUidHeader(res2, uid2);
    res2._t = res2._t || { attempts: [], waitMs: 0, totalMs: Math.round(nowMs(clock) - _t0()) };
    if (stillAuth || res2.status === 429 || res2.status >= 500) try { ring.onError(newKey); } catch {}
    doLog({ uid: uid2, model: _modelForLog(), totalMs: Math.round(nowMs(clock) - _t0()), balanceHit: false, error: stillAuth ? `still auth ${res2.status}` : undefined });
    if (stillAuth) throw failErr(`workbuddy auth still failing after refresh for ${uid2}: ${stillTxt.slice(0, 120)}`, _t0(), clock);
    return reshapeWorkbuddySse(res2);
  }

  let _t0Val = 0;
  let _modelVal = "";
  function _t0() { return _t0Val; }
  function _modelForLog() { return _modelVal; }

  async function runChat(body, activeRing, opts = {}) {
    const url = joinUrl(baseUrl, chatPath);
    const t0 = nowMs(clock);
    const clean = sanitizeToolSequence(body?.messages);
    if (clean.droppedCalls || clean.droppedResults || clean.movedResults || clean.injectedHead) {
      try { console.error(`[workbuddy] tool-sequence sanitized: dropped ${clean.droppedCalls} call(s), ${clean.droppedResults} result(s), moved ${clean.movedResults} result(s), head+${clean.injectedHead}, model=${body?.model || ""}`); } catch {}
      body = { ...body, messages: clean.messages };
    }
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
        // pin 模式撞封号：长冷却 + 把 403 原文透回（refresh 无效，别冒 502 让客户端以为网关坏了）。
        if (e?._t?.restricted || e?.restricted) {
          try { activeRing.onError(key, restrictedCooldownMs); } catch {}
          doLog({ uid: auth.uid, model: _modelVal, totalMs: Math.round(nowMs(clock) - t0), balanceHit: false, error: String(e.message).slice(0, 160) });
          return errRes(403, String(e.message), "account-restricted", auth.uid, t0, clock);
        }
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
        if (triedCount === 0) {
          // 封号冷却窗口内的重复请求：如实回 403（账号问题），别抛笼统 cooldown 冒成 502。
          if (lastRestricted && clock() - lastRestricted.at < restrictedCooldownMs) {
            return errRes(403, `workbuddy: all account(s) restricted (11140): ${String(lastRestricted.message).slice(0, 160)}`, "account-restricted", "", t0, clock);
          }
          throw failErr(`${id}: all API keys are in cooldown (last error < ${cooldownMs}ms ago) — provider temporarily unavailable`, t0, clock, { cooldownMs });
        }
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
        // 封号 11140：长冷却本号换下一个；冷却档走 restrictedCooldownMs（缺省 15min），别用 30s 短档反复白烧。
        // restricted 标记挂在 failErr 的 _t 上；SDK 通道对 4xx 抛的 AI_APICallError 带 statusCode/responseBody，一并识别。
        if (e?._t?.restricted || e?.restricted || isAccountRestricted(e?.statusCode, e?.responseBody)) {
          lastRestricted = { at: clock(), uid, message: String(e.responseBody || e.message || "").slice(0, 200) };
          try { activeRing.onError(key, restrictedCooldownMs); } catch {}
        } else try { activeRing.onError(key); } catch {}
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
        // 频率限制（腾讯 code 6004）：这个号撞了限流，但**额度还在**（total 可能还有几千点）。
        // 必须换下一个号顶，且绝不能 setBalance(total:0) —— 那会把好号永久跳过，
        // 是「429 原样吐回客户端、从不换号」在 2026-10-17 实锤的那条老路。
        // Note: 6004 的判据与冷却分档 — 见 .agents/notes/implemented/bug-fix/2026-10-18-workbuddy-6004-rate-limit-rotate.md
        if (isRateLimitedStatus(res.status, txt)) {
          const resetMs = parseRateLimitResetMs(txt, clock);
          // 冷却时长取「上游给的重置时刻」与固定下限的较大者；解析不出就只按固定档，
          // 且**封顶 10 分钟**：6004 的重置时间可能远在数小时后，照抄会把号冻到下班。
          const coolMs = Math.min(Math.max(resetMs || 0, cooldownMs), 10 * 60_000);
          try { activeRing.onError(key, coolMs); } catch {}
          doLog({ uid, model: _modelVal, totalMs: Math.round(nowMs(clock) - t0), balanceHit: false, error: `rate-limited(${coolMs}ms) ${txt.slice(0, 120)}` });
          lastErr = failErr(`workbuddy rate limited for ${uid}: ${txt.slice(0, 120)}`, t0, clock);
          if (activeRing.available() > 0) continue;
          res = rewrapBody(res, txt);
        } else {
          res = rewrapBody(res, txt);
        }
      }
      if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) try { activeRing.onError(key); } catch {}
      res = withUidHeader(res, uid);
      res._t = res._t || { attempts: [], waitMs: 0, totalMs: Math.round(nowMs(clock) - t0) };
      doLog({ uid, model: _modelVal, totalMs: Math.round(nowMs(clock) - t0), balanceHit: false });
      return res;
    }
    if (lastErr) {
      // 全号皆被封 11140：上游报文带可申诉的 displayMsg/displayTips，透回原文比模糊包装更利于用户自查；
      // 状态码用上游的 403（旧链是 502，客户端侧像网关坏了，实为账号问题）。
      if (lastErr._t?.restricted || lastErr.restricted) {
        lastRestricted = { at: clock(), uid: "", message: String(lastErr.message || "") };
        const uids = [...tried].filter((x) => x && x.includes("-")).join(",");
        const reason = `workbuddy all account(s) restricted (11140): ${uids || "n/a"} — ${String(lastErr.message).slice(0, 200)}`;
        const r = errRes(403, reason, "account-restricted", uids, t0, clock);
        return r;
      }
      throw lastErr;
    }
    throw failErr(`${id}: all workbuddy accounts exhausted or unavailable`, t0, clock);
  }

  return { runChat, authForKey, buildAuthHeaders, withUidHeader, attemptOnce: fetchOnce };
}
