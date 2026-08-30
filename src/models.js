const KNOWN_FREE_OPENCODE_MODELS = ["big-pickle"];
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_REFRESH_MS = 2 * 60 * 60 * 1000;
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function isFreeModel(id) {
  return (typeof id === "string" && id.endsWith("-free")) ||
    KNOWN_FREE_OPENCODE_MODELS.includes(id);
}

export function filterFreeModels(list) {
  const seen = new Set();
  const out = [];
  for (const m of list || []) {
    if (!(m && m.id)) continue;
    if (!isFreeModel(m.id)) continue;
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

export function createModelsService({ baseUrl, headers, ttlMs = CACHE_TTL_MS, refreshMs = DEFAULT_REFRESH_MS, cacheFile, providers } = {}) {
  // 多供应商聚合模式：给 `providers` 数组，则缓存并返回所有供应商的模型列表
  if (providers?.length) {
    let aggregate = null;
    let aggFetchedAt = 0;
    let lastAllowlistKey = "";
    async function currentAllowlistKey() {
      try {
        const { loadProviderAllowedModels, loadProviderAllowAnyModels } = await import("./state.js");
        return providers.map((p) => {
          const allowAny = loadProviderAllowAnyModels(p.id) ? "any" : "block";
          return `${p.id}:${allowAny}:${loadProviderAllowedModels(p.id).join(",")}`;
        }).join("|");
      } catch {
        return "";
      }
    }
    async function aggLoad() {
      const all = [];
      for (const p of providers) {
        try {
          let list = (await p.listModels?.()) ?? [];
          // 白名单过滤：空名单且 allowAny=false → 该供应商不暴露任何模型（安全默认全拦，auto 直接跳过该供应商）
          try {
            const { loadProviderAllowedModels, loadProviderAllowAnyModels } = await import("./state.js");
            const allowed = loadProviderAllowedModels(p.id);
            const allowAny = loadProviderAllowAnyModels(p.id);
            if (!allowed.length && !allowAny) {
              // 该供应商被全拦，auto 直接跳过整个供应商
              continue;
            }
            if (allowed.length) {
              const allowedSet = new Set(allowed);
              const { splitModelId } = await import("./providers/model-id.js");
              list = list.filter((m) => {
                if (!m || !m.id) return false;
                const { raw } = splitModelId(m.id, providers.map((x) => x.id));
                return allowedSet.has(String(raw || "").trim());
              });
            }
          } catch {}
          all.push(...list);
        } catch {
          // 单供应商取数失败不拖垮整体
        }
      }
      aggregate = { object: "list", data: all };
      try {
        lastAllowlistKey = await currentAllowlistKey();
      } catch {}
      if (cacheFile) persistModels(aggregate, cacheFile);
      return aggregate;
    }
    async function get() {
      const now = Date.now();
      if (aggregate && now - aggFetchedAt < ttlMs) {
        // 热更新白名单：allowlist 变化时，即使命中 TTL 也要重载（否则 clear 后仍返回旧过滤结果）
        try {
          const curKey = await currentAllowlistKey();
          if (curKey !== lastAllowlistKey) {
            const out = await aggLoad();
            aggFetchedAt = Date.now();
            return out;
          }
        } catch {}
        // 否则尝试在缓存上二次过滤（处理 allowlist 从空变非空等未触发重载的场景）
        try {
          const { loadProviderAllowedModels, loadProviderAllowAnyModels } = await import("./state.js");
          const { splitModelId } = await import("./providers/model-id.js");
          const filteredData = aggregate.data.filter((m) => {
            if (!m || !m.id) return false;
            const { provider, raw } = splitModelId(m.id, providers.map((x) => x.id));
            const allowed = loadProviderAllowedModels(provider);
            const allowAny = loadProviderAllowAnyModels(provider);
            if (!allowed.length && !allowAny) return false;
            if (!allowed.length) return true;
            return allowed.includes(String(raw || "").trim());
          });
          if (filteredData.length !== aggregate.data.length) return { ...aggregate, data: filteredData };
          return aggregate;
        } catch {
          return aggregate;
        }
      }
      const out = await aggLoad();
      aggFetchedAt = Date.now();
      return out;
    }
    return { get, startAutoRefresh: () => {}, stopAutoRefresh: () => {} };
  }
  let cache = null;
  let fetchedAt = 0;
  let inflight = null;
  let timer = null;

  async function load() {
    let data = await fetchUpstreamModels({ baseUrl, headers });
    // 白名单过滤：opencode 亦支持 allowlist
    try {
      const { loadProviderAllowedModels } = await import("./state.js");
      const allowed = loadProviderAllowedModels("opencode");
      if (allowed.length) {
        const allowedSet = new Set(allowed);
        data = { ...data, data: (data.data || []).filter((m) => m && m.id && allowedSet.has(String(m.id).trim())) };
      }
    } catch {}
    cache = data;
    fetchedAt = Date.now();
    if (cacheFile) persistModels(data, cacheFile);
    return data;
  }

  async function get() {
    const now = Date.now();
    if (cache && now - fetchedAt < ttlMs) return cache;
    if (inflight) return inflight;

    inflight = (async () => {
      try {
        return await load();
      } catch (err) {
        // serve stale on failure if we have it, else rethrow
        if (cache) return cache;
        throw err;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function startAutoRefresh(intervalMs = refreshMs) {
    if (timer) return stopAutoRefresh;
    timer = setInterval(() => {
      void load().catch(() => {
        // keep serving stale cache on background refresh failure
      });
    }, intervalMs);
    timer.unref?.();
    return stopAutoRefresh;
  }

  function stopAutoRefresh() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { get, startAutoRefresh, stopAutoRefresh };
}

async function fetchUpstreamModels({ baseUrl, headers, connectTimeoutMs = 30_000 }) {
  const url = `${baseUrl}/zen/v1/models`;
  for (let attempt = 0; ; attempt++) {
    const res = await attemptFetch(url, headers, connectTimeoutMs);
    if (res instanceof Error) {
      if (attempt < NETWORK_RETRIES) continue;
      throw res;
    }
    if (isRetryable(res.status) && attempt < STATUS_RETRIES) {
      await sleep(2000);
      continue;
    }
    if (!res.ok) throw new Error(`models fetch failed: HTTP ${res.status}`);
    const json = await res.json().catch(() => ({}));
    const raw = Array.isArray(json) ? json : json.data ?? json.models ?? [];
    return { object: "list", data: filterFreeModels(raw) };
  }
}

async function attemptFetch(url, headers, connectTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), connectTimeoutMs);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } catch (err) {
    return err;
  } finally {
    clearTimeout(timer);
  }
}

function isRetryable(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function persistModels(data, cacheFile) {
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ cachedAt: Date.now(), ...data }));
  } catch {
    // persistence is best-effort
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const NETWORK_RETRIES = 2;
const STATUS_RETRIES = 2;