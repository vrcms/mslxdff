import { joinModelId } from "./model-id.js";
import { createKeyRing } from "./keyring.js";
import { loadProviderKeys, loadProviderAuths, loadProviderBaseUrl, loadProviderShareKeys, saveProviderConfig, WORKBUDDY_DEFAULT_BASE_URL } from "../state.js";
import { writeFileSync, existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { getCachedBalance, setCachedBalance } from "./workbuddy-balance.js";

let UndiciAgent = null;
let UndiciFetch = null;
try {
  const mod = await import("undici");
  UndiciAgent = mod.Agent;
  UndiciFetch = mod.fetch;
} catch {}

function envInt(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}
function isTestEnv() {
  if (process.env.NODE_ENV === "test") return true;
  if (process.env.MSLXDFF_STATE_FILE && String(process.env.MSLXDFF_STATE_FILE).includes("mslxdff-test")) return true;
  if (process.argv.some((a) => String(a).includes("--test") || String(a).endsWith(".test.js"))) return true;
  if (Array.isArray(process.execArgv) && process.execArgv.some((a) => String(a).includes("--test"))) return true;
  if (process.env.NODE_TEST_CONTEXT) return true;
  return false;
}

function resolveBaseUrl(baseUrl) {
  if (baseUrl) return String(baseUrl).trim().replace(/\/+$/, "");
  const env = loadProviderBaseUrl("workbuddy");
  if (env) return env;
  return WORKBUDDY_DEFAULT_BASE_URL;
}

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

function isInsufficientStatus(status, bodyText, cached) {
  if (cached && Number(cached.total) === 0) return true;
  if (status === 402) return true;
  if (status === 403 || status === 429) {
    const t = String(bodyText || "").toLowerCase();
    if (t.includes("insufficient") || t.includes("quota") || t.includes("balance") || t.includes("credit") || t.includes("exhaust") || t.includes("402") || t.includes("10002") || t.includes("10003")) return true;
  }
  return false;
}

function withUidHeader(res, uid) {
  try {
    // try mutable set first
    res.headers.set("x-mslxdff-workbuddy-uid", uid);
    return res;
  } catch {
    try {
      const h = new Headers(res.headers);
      h.set("x-mslxdff-workbuddy-uid", uid);
      // clone with new headers, preserve body stream without consuming
      const clone = new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
      clone._t = res._t;
      return clone;
    } catch {
      return res;
    }
  }
}

function appendRotationLog({ uid, model, totalMs, balanceHit, error }) {
  try {
    const dirs = new Set();
    try {
      const sf = process.env.MSLXDFF_STATE_FILE;
      if (sf) {
        const cut = Math.max(sf.lastIndexOf("/"), sf.lastIndexOf("\\"));
        if (cut > 0) dirs.add(sf.slice(0, cut));
      }
    } catch {}
    const envDir = process.env.MSLXDFF_DAEMON_DIR || process.env.MSLXDFF_LOG_DIR;
    if (envDir) dirs.add(envDir);
    dirs.add(process.cwd());
    dirs.add(join(process.cwd(), "logs"));
    const line = `${new Date().toISOString()} uid=${uid} model=${model||"-"} totalMs=${totalMs} balanceHit=${balanceHit?1:0}${error?` error=${String(error).slice(0,120)}`:""}\n`;
    for (const dir of dirs) {
      try {
        mkdirSync(dir, { recursive: true });
        const file = join(dir, "workbuddy-rotation.log");
        appendFileSync(file, line);
        try {
          const st = statSync(file);
          if (st.size > 1024*1024) {
            const content = readFileSync(file, "utf8");
            writeFileSync(file, content.slice(-512*1024));
          }
        } catch {}
      } catch {}
    }
  } catch {}
}

export function createWorkbuddyProvider({
  baseUrl,
  apiKeys,
  apiKey,
  auths,
  connectTimeoutMs = Number(process.env.MSLXDFF_WORKBUDDY_TIMEOUT_MS) || 30_000,
  cooldownMs = envInt("MSLXDFF_WORKBUDDY_COOLDOWN_MS", 30_000),
  retry = {
    network: { attempts: 2, delayMs: 300 },
    429: { attempts: 1, delayMs: 100 },
    502: { attempts: 1, delayMs: 100 },
    503: { attempts: 1, delayMs: 100 },
    504: { attempts: 1, delayMs: 100 },
  },
  fetchImpl,
  file,
} = {}) {
  const id = "workbuddy";
  const resolvedBase = resolveBaseUrl(baseUrl);
  if (!fetchImpl) fetchImpl = UndiciFetch || fetch;

  // keys 优先显式传入，其次 state
  const keysFromState = loadProviderKeys(id, file ? { file } : {});
  const authsFromState = loadProviderAuths(id, file ? { file } : {});
  const keys = (() => {
    const list = [
      ...(Array.isArray(apiKeys) ? apiKeys : [apiKeys].filter(Boolean)),
      apiKey,
      ...(apiKeys === undefined && apiKey === undefined ? keysFromState : []),
    ].filter((k) => typeof k === "string" && k.trim().length);
    return [...new Set(list.map((k) => k.trim()))];
  })();
  let authList = Array.isArray(auths) && auths.length ? auths : authsFromState;

  // fallback scan auths/workbuddy-*.json if still empty
  if (!authList.length && !keys.length) {
    try {
      const authDir = process.env.WORKBUDDY_AUTH_DIR || (isTestEnv() ? join(tmpdir(), "mslxdff-test-auths") : (file && String(file).includes("mslxdff-") ? join(dirname(String(file)), "auths") : join(process.cwd(), "auths")));
      if (existsSync(authDir)) {
        const files = readdirSync(authDir).filter((f) => f.startsWith("workbuddy-") && f.endsWith(".json"));
        for (const f of files) {
          try {
            const j = JSON.parse(readFileSync(join(authDir, f), "utf8"));
            if (j?.auth?.accessToken && j?.account?.uid) {
              if (!keys.includes(j.auth.accessToken)) keys.push(j.auth.accessToken);
              authList.push({
                uid: j.account.uid,
                domain: j.auth.domain || "www.codebuddy.cn",
                enterpriseId: j.account.enterpriseId || "",
                refreshToken: j.auth.refreshToken || "",
              });
            }
          } catch {}
        }
      }
    } catch {}
  }

  const ring = createKeyRing(keys, { cooldownMs });

  let dispatcher = null;
  let agent = null;
  if (UndiciAgent) {
    try {
      agent = new UndiciAgent({
        keepAliveTimeout: envInt("MSLXDFF_WORKBUDDY_KEEPALIVE_TIMEOUT", 30_000),
        keepAliveMaxTimeout: envInt("MSLXDFF_WORKBUDDY_KEEPALIVE_MAX_TIMEOUT", 60_000),
        connections: envInt("MSLXDFF_WORKBUDDY_KEEPALIVE_CONNECTIONS", 20),
        pipelining: 1,
      });
      dispatcher = agent;
    } catch {}
  }

  function authForKey(key) {
    const idx = keys.indexOf(key);
    if (idx >= 0 && authList[idx]) return authList[idx];
    // try match by uid if key's JWT contains uid? fallback to first auth
    if (authList.length) return authList[0];
    return { uid: "", domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "" };
  }

  async function refreshTokenFor(key, auth) {
    const rt = auth?.refreshToken;
    const uid = auth?.uid;
    if (!rt || !uid) return null;
    const url = `${resolvedBase}/v2/plugin/auth/token/refresh`;
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      "X-Refresh-Token": rt,
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
      const j = JSON.parse(text);
      if (j.code === 0 && j.data?.accessToken) {
        const newAt = j.data.accessToken;
        const newRt = j.data.refreshToken || rt;
        // update in-memory
        const idx = keys.indexOf(key);
        if (idx >= 0) {
          keys[idx] = newAt;
          // also update ring? createKeyRing holds reference? need to reset
          // simplest: save to state and update authList
          authList[idx] = { ...auth, refreshToken: newRt };
          try {
            saveProviderConfig(id, { baseUrl: resolvedBase, keys: [...keys], auths: [...authList] }, file ? { file } : {});
          } catch {}
          try {
            const authDir = process.env.WORKBUDDY_AUTH_DIR || (isTestEnv() ? join(tmpdir(), "mslxdff-test-auths") : (file && String(file).includes("mslxdff-") ? join(dirname(String(file)), "auths") : join(process.cwd(), "auths")));
            mkdirSync(authDir, { recursive: true });
            const expAt = (() => { try { return JSON.parse(Buffer.from(newAt.split(".")[1], "base64").toString()).exp; } catch { return Math.floor(Date.now()/1000)+5184000; } })();
            const doc = { account: { uid, enterpriseId: auth.enterpriseId || "", nickname: "" }, auth: { accessToken: newAt, refreshToken: newRt, expiresAt: expAt, domain: auth.domain || "www.codebuddy.cn" } };
            const fp = join(authDir, `workbuddy-${uid}.json`);
            const tmp = fp + ".tmp";
            writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
            try { if (existsSync(fp)) { const { unlinkSync, renameSync } = await import("node:fs"); unlinkSync(fp); renameSync(tmp, fp); } else { const { renameSync } = await import("node:fs"); renameSync(tmp, fp); } } catch { writeFileSync(fp, JSON.stringify(doc, null, 2), { mode: 0o600 }); }
          } catch {}
        }
        return newAt;
      }
    } catch {}
    return null;
  }

  async function attemptOnce(url, body, key) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${id} timed out after ${connectTimeoutMs}ms`)), connectTimeoutMs);
    try {
      const auth = authForKey(key);
      const headers = buildAuthHeaders(key, auth);
      // ensure stream true
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
    const url = `${resolvedBase}/v2/chat/completions`;
    const t0 = performance.now();
    const preferredUid = opts?.workbuddyUid ? String(opts.workbuddyUid).trim() : "";
    const modelForLog = body?.model || "";
    // manual pin: force single uid
    if (preferredUid) {
      const idx = authList.findIndex(a => a.uid === preferredUid || a.uid.startsWith(preferredUid));
      if (idx < 0) {
        const errBody = JSON.stringify({ error: `workbuddy uid not found: ${preferredUid}` });
        const res = new Response(errBody, { status: 403, headers: { "Content-Type": "application/json", "x-mslxdff-workbuddy-reason": "uid-not-found", "x-mslxdff-workbuddy-uid": preferredUid } });
        res._t = { attempts: [], waitMs: 0, totalMs: Math.round(performance.now() - t0) };
        return res;
      }
      const key = keys[idx];
      const auth = authList[idx];
      const cached = getCachedBalance(auth.uid);
      if (cached && Number(cached.total) === 0) {
        const errBody = JSON.stringify({ error: `workbuddy uid in cooldown (balance 0): ${auth.uid}` });
        const res = new Response(errBody, { status: 403, headers: { "Content-Type": "application/json", "x-mslxdff-workbuddy-reason": "uid-cooling", "x-mslxdff-workbuddy-uid": auth.uid } });
        res._t = { attempts: [], waitMs: 0, totalMs: Math.round(performance.now() - t0) };
        return res;
      }
      // check ring cooldown by peeking if key is cooling (ring doesn't expose, so try next and see)
      // we enforce by attempting; if ring would skip, we still allow manual but mark cooling
      // do single attempt with this key
      const attempts = [];
      let waitMs = 0;
      for (let attempt = 0; ; attempt++) {
        const t = performance.now();
        let result = await attemptOnce(url, body, key);
        const type = result instanceof Error ? "network" : `http${result?.status}`;
        attempts.push({ attempt, type, ms: Math.round(performance.now() - t) });
        if (result instanceof Error) {
          const entry = retry?.network;
          if (entry && attempt < entry.attempts) { await sleep(entry.delayMs); waitMs += entry.delayMs; continue; }
          activeRing.onError(key);
          result._t = { attempts, waitMs, totalMs: Math.round(performance.now() - t0) };
          throw result;
        }
        if ((result.status === 401 || result.status === 403) && attempt === 0) {
          const newKey = await refreshTokenFor(key, auth);
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
              res2._t = { attempts, waitMs, totalMs: Math.round(performance.now() - t0), refreshed: true };
              res2 = withUidHeader(res2, auth2.uid || auth.uid);
              if (res2.status === 401 || res2.status === 403 || res2.status === 429 || res2.status >= 500) activeRing.onError(newKey);
              appendRotationLog({ uid: auth2.uid || auth.uid, model: modelForLog, totalMs: Math.round(performance.now() - t0), balanceHit: false });
              return res2;
            } catch (e2) { e2._t = { attempts, waitMs, totalMs: Math.round(performance.now() - t0) }; throw e2; } finally { clearTimeout(timer2); }
          }
        }
        const entry = retry?.[result.status];
        if (entry && attempt < entry.attempts) { await sleep(entry.delayMs); waitMs += entry.delayMs; continue; }
        if (result.status === 401 || result.status === 403 || result.status === 429 || result.status >= 500) activeRing.onError(key);
        result = withUidHeader(result, auth.uid);
        result._t = { attempts, waitMs, totalMs: Math.round(performance.now() - t0) };
        appendRotationLog({ uid: auth.uid, model: modelForLog, totalMs: Math.round(performance.now() - t0), balanceHit: false });
        return result;
      }
    }

    // auto rotation: try each key at most once, with ring.next() order
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
          err._t = { attempts, waitMs, totalMs: Math.round(performance.now() - t0), cooldownMs };
          throw err;
        }
        break;
      }
      const auth = authForKey(key);
      const uid = auth?.uid || "";
      if (tried.has(uid || key)) continue;
      tried.add(uid || key);
      const cached = uid ? getCachedBalance(uid) : null;
      if (cached && Number(cached.total) === 0) {
        // treat as insufficient without request, cooldown and try next
        activeRing.onError(key);
        setCachedBalance(uid, { ...cached, total: 0 });
        appendRotationLog({ uid, model: modelForLog, totalMs: Math.round(performance.now() - t0), balanceHit: true });
        continue;
      }
      if (!key && activeRing.size === 0) {
        const err = new Error(`${id}: missing MSLXDFF_WORKBUDDY_KEY (chat requires a real key) — run node workbuddy-token-auto.js`);
        err._t = { attempts, waitMs, totalMs: Math.round(performance.now() - t0) };
        throw err;
      }
      // single attempt with retry for network/429
      let result = null;
      let attempt = 0;
      for (; ; attempt++) {
        const t = performance.now();
        result = await attemptOnce(url, body, key);
        const type = result instanceof Error ? "network" : `http${result?.status}`;
        attempts.push({ attempt: triedCount*10+attempt, type, ms: Math.round(performance.now() - t), uid });
        if (result instanceof Error) {
          const entry = retry?.network;
          if (entry && attempt < entry.attempts) { await sleep(entry.delayMs); waitMs += entry.delayMs; continue; }
          activeRing.onError(key);
          lastErr = result;
          result._t = { attempts, waitMs, totalMs: Math.round(performance.now() - t0) };
          break;
        }
        if ((result.status === 401 || result.status === 403) && attempt === 0) {
          const newKey = await refreshTokenFor(key, auth);
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
              res2._t = { attempts, waitMs, totalMs: Math.round(performance.now() - t0), refreshed: true };
              if (res2.status === 401 || res2.status === 403 || res2.status === 429 || res2.status >= 500) activeRing.onError(newKey);
              res2 = withUidHeader(res2, auth2.uid || uid);
              appendRotationLog({ uid: auth2.uid || uid, model: modelForLog, totalMs: Math.round(performance.now() - t0), balanceHit: false });
              return res2;
            } catch (e2) { e2._t = { attempts, waitMs, totalMs: Math.round(performance.now() - t0) }; lastErr = e2; break; } finally { clearTimeout(timer2); }
          }
        }
        const entry = retry?.[result.status];
        if (entry && attempt < entry.attempts) { await sleep(entry.delayMs); waitMs += entry.delayMs; continue; }
        break;
      }
      if (result instanceof Error) {
        // network error already handled, try next key if any
        continue;
      }
      // check insufficient -> rotate
      let bodyText = "";
      let isInsuff = false;
      if (result.status === 402 || result.status === 403 || result.status === 429) {
        try { bodyText = await result.clone().text(); } catch { try { bodyText = await result.text(); } catch { bodyText = ""; } }
        isInsuff = isInsufficientStatus(result.status, bodyText, cached);
      }
      if (isInsuff) {
        activeRing.onError(key);
        if (uid) setCachedBalance(uid, { total: 0, dailyPacks: 0, activeCount: 0, nextExpire: null, fetchedAt: Date.now() });
        appendRotationLog({ uid, model: modelForLog, totalMs: Math.round(performance.now() - t0), balanceHit: true, error: bodyText.slice(0,120) });
        // need to recreate response for next loop? we already cloned, so result is still usable but we discard it
        lastErr = new Error(`workbuddy insufficient for ${uid}: ${bodyText.slice(0,120)}`);
        lastErr._t = { attempts, waitMs, totalMs: Math.round(performance.now() - t0) };
        continue;
      }
      // success or non-insufficient error -> return
      if (result.status === 401 || result.status === 403 || result.status === 429 || result.status >= 500) activeRing.onError(key);
      result = withUidHeader(result, uid);
      result._t = { attempts, waitMs, totalMs: Math.round(performance.now() - t0) };
      appendRotationLog({ uid, model: modelForLog, totalMs: Math.round(performance.now() - t0), balanceHit: false });
      return result;
    }
    // all tried, none succeeded
    if (lastErr) throw lastErr;
    const err = new Error(`${id}: all workbuddy accounts exhausted or unavailable`);
    err._t = { attempts, waitMs, totalMs: Math.round(performance.now() - t0) };
    throw err;
  }

  async function chat(body, opts = {}) {
    // support header/model pin via opts or body._workbuddyUid
    const uid = opts?.workbuddyUid || body?._workbuddyUid;
    const cleanBody = uid ? (({ _workbuddyUid, ...rest }) => rest)(body) : body;
    return runChat(cleanBody, ring, uid ? { workbuddyUid: uid } : {});
  }

  async function chatWithKeys(body, keysOverride) {
    // workbuddy 默认不外借，需显式 MSLXDFF_WORKBUDDY_SHARE_KEYS=1 或 state providerShareKeys.workbuddy=true
    const shareOn = (() => {
      try { return loadProviderShareKeys(id, file ? { file } : {}); } catch { return false; }
    })();
    if (!shareOn) {
      // fallback to normal chat (ignore share)
      return runChat(body, ring);
    }
    const tmp = createKeyRing(keysOverride, { cooldownMs });
    const tmpAuth = authList[0] || { uid: "", domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "" };
    const savedKeys = [...keys];
    const savedAuthList = [...authList];
    try {
      keys.length = 0; keys.push(...keysOverride);
      authList = keysOverride.map(() => tmpAuth);
      return await runChat(body, tmp);
    } finally {
      keys.length = 0; keys.push(...savedKeys);
      authList = savedAuthList;
    }
  }

  // listModels / preheat shared
  const CACHE_TTL_MS = 10 * 60 * 1000;
  let cache = null;
  let fetchedAt = 0;

  function creditsValue(c) {
    if (!c || !String(c).trim()) return 0;
    const m = String(c).match(/x([\d.]+)/);
    return m ? parseFloat(m[1]) : 999;
  }

  async function listModels() {
    const now = Date.now();
    if (cache && now - fetchedAt < CACHE_TTL_MS) return cache;
    const url = `${resolvedBase}/console/enterprises/personal/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${id} models timed out`)), 15_000);
    try {
      const key = ring.next() || keys[0] || "";
      const auth = authForKey(key);
      const headers = {
        Accept: "application/json",
        "X-User-Id": auth?.uid || "",
        "X-Domain": auth?.domain || "www.codebuddy.cn",
        "X-Product": "SaaS",
        "User-Agent": "CLI/2.115.0 WorkBuddy/2.115.0",
        Origin: "https://www.codebuddy.cn",
        Referer: "https://www.codebuddy.cn/",
      };
      if (key) headers["Authorization"] = `Bearer ${key}`;
      const opts = { headers, signal: controller.signal };
      if (dispatcher) opts.dispatcher = dispatcher;
      const res = await fetchImpl(url, opts);
      if (!res.ok) return [];
      const json = await res.json().catch(() => ({}));
      const models = json?.data?.models;
      if (!Array.isArray(models)) return [];
      const sorted = [...models].sort((a, b) => creditsValue(a.credits) - creditsValue(b.credits));
      cache = sorted.filter((m) => m && typeof m.id === "string").map((m) => ({ ...m, id: joinModelId(id, m.id) }));
      fetchedAt = now;
      return cache;
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  async function preheat() {
    const url = `${resolvedBase}/console/enterprises/personal/models`;
    const t0 = performance.now();
    try {
      const key = ring.next() || keys[0] || "";
      const auth = authForKey(key);
      const headers = {
        Accept: "application/json",
        "X-User-Id": auth?.uid || "",
        "X-Domain": auth?.domain || "www.codebuddy.cn",
        "X-Product": "SaaS",
        "User-Agent": "CLI/2.115.0 WorkBuddy/2.115.0",
        Origin: "https://www.codebuddy.cn",
        Referer: "https://www.codebuddy.cn/",
      };
      if (key) headers["Authorization"] = `Bearer ${key}`;
      const opts = { headers };
      if (dispatcher) opts.dispatcher = dispatcher;
      const res = await fetchImpl(url, opts);
      try { if (res.body) await res.text().catch(() => {}); } catch {}
      return { ok: res.ok, status: res.status, ms: Math.round(performance.now() - t0) };
    } catch (err) {
      return { ok: false, error: String(err?.message || err), ms: Math.round(performance.now() - t0) };
    }
  }

  async function close() {
    if (agent && typeof agent.close === "function") {
      try { await agent.close(); } catch {}
    }
  }

  return {
    id,
    chat,
    chatWithKeys,
    listModels,
    preheat,
    close,
    agent,
    keyRing: ring,
    baseUrl: resolvedBase,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
