import { createKeyRing } from "./keyring.js";
import { joinModelId } from "./model-id.js";

let UndiciAgent = null;
let UndiciFetch = null;
try {
  const mod = await import("undici");
  UndiciAgent = mod.Agent;
  UndiciFetch = mod.fetch;
} catch {}

export function envInt(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

export function joinUrl(base, path) {
  const b = String(base || "").trim().replace(/\/+$/, "");
  const p = String(path || "").trim();
  if (!p) return b;
  const pp = p.startsWith("/") ? p : `/${p}`;
  return `${b}${pp}`;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function getUndici() {
  return { UndiciAgent, UndiciFetch };
}

export function createAgent({ keepAliveTimeout = 30_000, keepAliveMaxTimeout = 60_000, connections = 20 } = {}) {
  if (!UndiciAgent) return { agent: null, dispatcher: null };
  try {
    const agent = new UndiciAgent({ keepAliveTimeout, keepAliveMaxTimeout, connections, pipelining: 1 });
    return { agent, dispatcher: agent };
  } catch {
    return { agent: null, dispatcher: null };
  }
}

export function collectApiKeysGeneric(id, apiKeys, apiKey, loadKeys) {
  const list = [
    ...(Array.isArray(apiKeys) ? apiKeys : [apiKeys].filter(Boolean)),
    apiKey,
    ...(apiKeys === undefined && apiKey === undefined ? loadKeys(id) : []),
  ].filter((k) => typeof k === "string" && k.trim().length);
  return [...new Set(list.map((k) => k.trim()))];
}

export function createChatRunner({ id, ring, cooldownMs, retry, fetchImpl, dispatcher, buildHeaders, getUrl, connectTimeoutMs = 30_000 }) {
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
    const url = getUrl();
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
        if (entry && attempt < entry.attempts) { await sleep(entry.delayMs); waitMs += entry.delayMs; continue; }
        activeRing.onError(key);
        result._t = { attempts, waitMs, totalMs: Math.round(performance.now() - t0) };
        throw result;
      }
      const entry = retry?.[result.status];
      if (entry && attempt < entry.attempts) { await sleep(entry.delayMs); waitMs += entry.delayMs; continue; }
      if (result.status === 401 || result.status === 403 || result.status === 429 || result.status >= 500) activeRing.onError(key);
      result._t = { attempts, waitMs, totalMs: Math.round(performance.now() - t0) };
      return result;
    }
  }

  return { attemptOnce, runChat };
}

export function createListModelsRunner({ id, ring, dispatcher, fetchImpl, getUrl, mapModel }) {
  const CACHE_TTL_MS = 10 * 60 * 1000;
  let cache = null;
  let fetchedAt = 0;
  async function listModels() {
    const now = Date.now();
    if (cache && now - fetchedAt < CACHE_TTL_MS) return cache;
    const url = getUrl();
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
      const mapped = mapModel ? mapModel(raw) : raw;
      cache = mapped.filter((m) => m && typeof m.id === "string").map((m) => ({ ...m, id: joinModelId(id, m.id) }));
      fetchedAt = now;
      return cache;
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
  return { listModels, _cache: () => cache };
}

export function createPreheatRunner({ dispatcher, fetchImpl, getUrl, id, ring, loadKeys }) {
  async function preheat() {
    const url = getUrl();
    const t0 = performance.now();
    try {
      const headers = { Accept: "application/json" };
      const key = (loadKeys ? loadKeys(id)[0] : ring.next()) || ring.next();
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
  return { preheat };
}
