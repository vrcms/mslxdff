import { joinModelId } from "./model-id.js";
import { createKeyRing } from "./keyring.js";
import { loadProviderKeys, loadProviderBaseUrl, loadProviderModelsPath, loadProviderChatPath } from "../state.js";

function joinUrl(base, path) {
  const b = String(base || "").trim().replace(/\/+$/, "");
  const p = String(path || "").trim();
  if (!p) return b;
  const pp = p.startsWith("/") ? p : `/${p}`;
  return `${b}${pp}`;
}

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

function collectApiKeys(id, apiKeys, apiKey) {
  const list = [
    ...(Array.isArray(apiKeys) ? apiKeys : [apiKeys].filter(Boolean)),
    apiKey,
    ...(apiKeys === undefined && apiKey === undefined ? loadProviderKeys(id) : []),
  ].filter((k) => typeof k === "string" && k.trim().length);
  return [...new Set(list.map((k) => k.trim()))];
}

function resolveBaseUrl(id, baseUrl) {
  if (baseUrl) return String(baseUrl).trim().replace(/\/+$/, "");
  const env = loadProviderBaseUrl(id);
  if (env) return env;
  return "";
}

export function createGenericProvider({
  id,
  baseUrl,
  apiKeys,
  apiKey,
  modelsPath,
  chatPath,
  connectTimeoutMs = Number(process.env.MSLXDFF_GENERIC_TIMEOUT_MS) || 30_000,
  cooldownMs = envInt("MSLXDFF_GENERIC_COOLDOWN_MS", 30_000),
  retry = {
    network: { attempts: 2, delayMs: 300 },
    429: { attempts: 1, delayMs: 100 },
    502: { attempts: 1, delayMs: 100 },
    503: { attempts: 1, delayMs: 100 },
    504: { attempts: 1, delayMs: 100 },
  },
  fetchImpl,
  headers: extraHeaders,
  noAgent = false,
  file,
} = {}) {
  if (!id) throw new Error("generic provider requires id");
  const resolvedBase = resolveBaseUrl(id, baseUrl);
  if (!resolvedBase) throw new Error(`generic provider ${id}: missing baseUrl`);
  if (!fetchImpl) fetchImpl = UndiciFetch || fetch;
  const resolvedModelsPath = modelsPath || loadProviderModelsPath(id, file ? { file } : {});
  const resolvedChatPath = chatPath || loadProviderChatPath(id, file ? { file } : {});

  const ring = createKeyRing(collectApiKeys(id, apiKeys, apiKey), { cooldownMs });

  let dispatcher = null;
  let agent = null;
  if (UndiciAgent && !noAgent) {
    try {
      agent = new UndiciAgent({
        keepAliveTimeout: envInt("MSLXDFF_GENERIC_KEEPALIVE_TIMEOUT", 30_000),
        keepAliveMaxTimeout: envInt("MSLXDFF_GENERIC_KEEPALIVE_MAX_TIMEOUT", 60_000),
        connections: envInt("MSLXDFF_GENERIC_KEEPALIVE_CONNECTIONS", 20),
        pipelining: 1,
      });
      dispatcher = agent;
    } catch {}
  }

  function buildHeaders(body, key) {
    const isStream = body?.stream !== false;
    const h = {
      "Content-Type": "application/json",
      "Accept": isStream ? "text/event-stream" : "*/*",
      "User-Agent": "mslxdff",
    };
    if (key) h["Authorization"] = `Bearer ${key}`;
    return { ...h, ...extraHeaders };
  }

  async function attemptOnce(url, body, key, activeRing) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${id} timed out after ${connectTimeoutMs}ms`)), connectTimeoutMs);
    try {
      const opts = { method: "POST", headers: buildHeaders(body, key), body: JSON.stringify(body), signal: controller.signal };
      if (dispatcher) opts.dispatcher = dispatcher;
      const res = await fetchImpl(url, opts);
      if (res.status === 401 && !activeRing.size) return { __needKey: true };
      return res;
    } catch (err) {
      return err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function runChat(body, activeRing, sourceKey) {
    const url = joinUrl(resolvedBase, resolvedChatPath);
    const t0 = performance.now();
    const attempts = [];
    let waitMs = 0;
    const key = activeRing.next();
    if (!key && activeRing.size > 0) {
      const err = new Error(`${id}: all API keys are in cooldown (last error < ${cooldownMs}ms ago) — provider temporarily unavailable`);
      err._t = { attempts: [], waitMs: 0, totalMs: Math.round(performance.now() - t0), cooldownMs };
      throw err;
    }
    for (let attempt = 0; ; attempt++) {
      const t = performance.now();
      const result = await attemptOnce(url, body, key, activeRing);
      const type = result instanceof Error ? "network" : `http${result?.status}`;
      attempts.push({ attempt, type, ms: Math.round(performance.now() - t) });
      if (result?.__needKey) {
        const err = new Error(`${id}: missing ${sourceKey} (chat requires a real key)`);
        err._t = { attempts, waitMs, totalMs: Math.round(performance.now() - t0) };
        throw err;
      }
      if (result instanceof Error) {
        const entry = retry?.network;
        if (entry && attempt < entry.attempts) {
          await sleep(entry.delayMs);
          waitMs += entry.delayMs;
          continue;
        }
        activeRing.onError(key);
        result._t = { attempts, waitMs, totalMs: Math.round(performance.now() - t0) };
        throw result;
      }
      const entry = retry?.[result.status];
      if (entry && attempt < entry.attempts) {
        await sleep(entry.delayMs);
        waitMs += entry.delayMs;
        continue;
      }
      if (result.status === 401 || result.status === 403 || result.status === 429 || result.status >= 500) activeRing.onError(key);
      result._t = { attempts, waitMs, totalMs: Math.round(performance.now() - t0) };
      return result;
    }
  }

  async function chat(body) {
    return runChat(body, ring, `MSLXDFF_${id.toUpperCase()}_KEY`);
  }

  async function chatWithKeys(body, keys) {
    const tmp = createKeyRing(keys, { cooldownMs });
    return runChat(body, tmp, "shared provider keys");
  }

  const CACHE_TTL_MS = 10 * 60 * 1000;
  let cache = null;
  let fetchedAt = 0;
  async function listModels() {
    const now = Date.now();
    if (cache && now - fetchedAt < CACHE_TTL_MS) return cache;
    const url = joinUrl(resolvedBase, resolvedModelsPath);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${id} models timed out`)), 15_000);
    try {
      const headers = { Accept: "application/json" };
      const key = ring.next();
      if (key) headers["Authorization"] = `Bearer ${key}`;
      const opts = { headers, signal: controller.signal };
      if (dispatcher) opts.dispatcher = dispatcher;
      const res = await fetchImpl(url, opts);
      if (!res.ok) return [];
      const json = await res.json().catch(() => ({}));
      const raw = Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
      // 通用：不过滤 pricing，全部前缀化
      cache = raw.filter((m) => m && typeof m.id === "string").map((m) => ({ ...m, id: joinModelId(id, m.id) }));
      fetchedAt = now;
      return cache;
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  async function preheat() {
    const url = joinUrl(resolvedBase, resolvedModelsPath);
    const t0 = performance.now();
    try {
      const headers = { Accept: "application/json" };
      const key = loadProviderKeys(id)[0] || ring.next();
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
