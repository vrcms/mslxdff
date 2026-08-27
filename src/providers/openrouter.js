import { joinModelId } from "./model-id.js";

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

// OpenRouter Provider：OpenAI 兼容 `/api/v1`，Bear 鉴权 + HTTP-Referer/X-Title 品牌头。
// 免费模型 = pricing.prompt/completion 全为 0；模型 id 对外带 `openrouter/` 前缀。
export function createOpenRouterProvider({
  apiKey = process.env.MSLXDFF_OPENROUTER_KEY || "",
  baseUrl = process.env.MSLXDFF_OPENROUTER_BASE_URL || DEFAULT_BASE_URL,
  connectTimeoutMs = Number(process.env.MSLXDFF_OPENROUTER_TIMEOUT_MS) || 30_000,
  retry = {
    network: { attempts: 2, delayMs: 300 },
    429: { attempts: 1, delayMs: 100 },
    502: { attempts: 1, delayMs: 100 },
    503: { attempts: 1, delayMs: 100 },
    504: { attempts: 1, delayMs: 100 },
  },
  fetchImpl,
  headers: extraHeaders,
} = {}) {
  if (!fetchImpl) fetchImpl = UndiciFetch || fetch;

  let dispatcher = null;
  let agent = null;
  if (UndiciAgent) {
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

  if (!apiKey) {
    // 无 key 时禁用一个关键能力并给出可观测错误，但构造不抛（便于测试/降级）
    apiKey = "";
  }

  function buildHeaders(body) {
    const isStream = body?.stream !== false;
    const h = {
      "Content-Type": "application/json",
      "Accept": isStream ? "text/event-stream" : "*/*",
      "User-Agent": "mslxdff",
    };
    if (apiKey) h["Authorization"] = `Bearer ${apiKey}`;
    h["HTTP-Referer"] = process.env.MSLXDFF_OPENROUTER_REFERER || "https://github.com/mslxdff";
    h["X-Title"] = process.env.MSLXDFF_OPENROUTER_TITLE || "mslxdff";
    return { ...h, ...extraHeaders };
  }

  async function attemptOnce(url, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`openrouter timed out after ${connectTimeoutMs}ms`)), connectTimeoutMs);
    try {
      const opts = { method: "POST", headers: buildHeaders(body), body: JSON.stringify(body), signal: controller.signal };
      if (dispatcher) opts.dispatcher = dispatcher;
      const res = await fetchImpl(url, opts);
      if (res.status === 401 && !apiKey) return { __needKey: true };
      return res;
    } catch (err) {
      return err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function chat(body) {
    const url = `${baseUrl}/chat/completions`;
    const t0 = performance.now();
    const attempts = [];
    let waitMs = 0;
    for (let attempt = 0; ; attempt++) {
      const t = performance.now();
      const result = await attemptOnce(url, body);
      attempts.push({
        attempt,
        type: result instanceof Error ? "network" : `http${result?.status}`,
        ms: Math.round(performance.now() - t),
      });
      if (result?.__needKey) {
        const err = new Error("openrouter: missing MSLXDFF_OPENROUTER_KEY (chat requires a real key)");
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
        result._t = { attempts, waitMs, totalMs: Math.round(performance.now() - t0) };
        throw result;
      }
      const entry = retry?.[result.status];
      if (entry && attempt < entry.attempts) {
        await sleep(entry.delayMs);
        waitMs += entry.delayMs;
        continue;
      }
      result._t = { attempts, waitMs, totalMs: Math.round(performance.now() - t0) };
      return result;
    }
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

  return { id: "openrouter", chat, listModels, preheat, close, agent };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}