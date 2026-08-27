import { joinModelId } from "./model-id.js";
import { createKeyRing } from "./keyring.js";
import { loadProviderKeys } from "../state.js";

let UndiciAgent = null;
let UndiciFetch = null;
try {
  const mod = await import("undici");
  UndiciAgent = mod.Agent;
  UndiciFetch = mod.fetch;
} catch {}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

function envInt(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

// 把 `apiKeys`(数组) + `apiKey`(单串) + state 的 key 合并成去重数组。
// state 为空时只看显式传入；两者皆空 → []（无 key）。
function collectApiKeys(apiKeys, apiKey) {
  const list = [
    ...(Array.isArray(apiKeys) ? apiKeys : [apiKeys].filter(Boolean)),
    apiKey,
    ...(apiKeys === undefined && apiKey === undefined ? loadProviderKeys("openrouter") : []),
  ].filter((k) => typeof k === "string" && k.trim().length);
  return [...new Set(list.map((k) => k.trim()))];
}

export function createOpenRouterProvider({
  apiKeys,
  apiKey,
  baseUrl = process.env.MSLXDFF_OPENROUTER_BASE_URL || DEFAULT_BASE_URL,
  connectTimeoutMs = Number(process.env.MSLXDFF_OPENROUTER_TIMEOUT_MS) || 30_000,
  cooldownMs = envInt("MSLXDFF_OPENROUTER_COOLDOWN_MS", 30_000),
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
} = {}) {
  if (!fetchImpl) fetchImpl = UndiciFetch || fetch;

  const ring = createKeyRing(collectApiKeys(apiKeys, apiKey), { cooldownMs });

  let dispatcher = null;
  let agent = null;
  if (UndiciAgent && !noAgent) {
    try {
      agent = new UndiciAgent({
        keepAliveTimeout: envInt("MSLXDFF_OA_KEEPALIVE_TIMEOUT", 30_000),
        keepAliveMaxTimeout: envInt("MSLXDFF_OA_KEEPALIVE_MAX_TIMEOUT", 60_000),
        connections: envInt("MSLXDFF_OA_KEEPALIVE_CONNECTIONS", 20),
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
    h["HTTP-Referer"] = process.env.MSLXDFF_OPENROUTER_REFERER || "https://github.com/mslxdff";
    h["X-Title"] = process.env.MSLXDFF_OPENROUTER_TITLE || "mslxdff";
    return { ...h, ...extraHeaders };
  }

  async function attemptOnce(url, body, key, activeRing) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`openrouter timed out after ${connectTimeoutMs}ms`)), connectTimeoutMs);
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
    const url = `${baseUrl}/chat/completions`;
    const t0 = performance.now();
    const attempts = [];
    let waitMs = 0;

    // 轮转取一个可用 key；仅当"有 key 但全部在冷却"才算供应商暂时失效。
    // 没有配置任何 key 时不在这拦截——下降到 401 无 key 报错路径（__needKey）。
    const key = activeRing.next();
    if (!key && activeRing.size > 0) {
      const err = new Error(`openrouter: all API keys are in cooldown (last error < ${cooldownMs}ms ago) — provider temporarily unavailable`);
      err._t = { attempts: [], waitMs: 0, totalMs: Math.round(performance.now() - t0), cooldownMs };
      throw err;
    }

    for (let attempt = 0; ; attempt++) {
      const t = performance.now();
      const result = await attemptOnce(url, body, key, activeRing);
      const type = result instanceof Error ? "network" : `http${result?.status}`;
      attempts.push({ attempt, type, ms: Math.round(performance.now() - t) });
      if (result?.__needKey) {
        const err = new Error(`openrouter: missing ${sourceKey} (chat requires a real key)`);
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
    return runChat(body, ring, "MSLXDFF_OPENROUTER_KEY");
  }

  // ADR-0008 瞬时共享：用组员方传来的临时 key 发布请求（不污染本 provider 的持久 ring）。
  async function chatWithKeys(body, keys) {
    const tmp = createKeyRing(keys, { cooldownMs });
    return runChat(body, tmp, "shared provider keys");
  }

  // 拉免费模型：pricing 全 0 + 前缀化；可匿名
  const CACHE_TTL_MS = 10 * 60 * 1000;
  let cache = null;
  let fetchedAt = 0;
  async function listModels() {
    const now = Date.now();
    if (cache && now - fetchedAt < CACHE_TTL_MS) return cache;
    const url = `${baseUrl}/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("openrouter models timed out")), 15_000);
    try {
      const opts = { headers: { Accept: "application/json" }, signal: controller.signal };
      if (dispatcher) opts.dispatcher = dispatcher;
      const res = await fetchImpl(url, opts);
      if (!res.ok) return [];
      const json = await res.json().catch(() => ({}));
      const raw = Array.isArray(json.data) ? json.data : [];
      const free = raw.filter((m) =>
        Number(m.pricing?.prompt || 0) === 0 && Number(m.pricing?.completion || 0) === 0
      );
      cache = free.map((m) => ({ ...m, id: joinModelId("openrouter", m.id) }));
      fetchedAt = now;
      return cache;
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  async function preheat() {
    const url = `${baseUrl}/models`;
    const t0 = performance.now();
    try {
      const opts = { headers: { Accept: "application/json" } };
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
    id: "openrouter",
    chat,
    chatWithKeys,
    listModels,
    preheat,
    close,
    agent,
    keyRing: ring,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}