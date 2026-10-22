const KNOWN_FREE_OPENCODE_MODELS = ["big-pickle"];
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_REFRESH_MS = 2 * 60 * 60 * 1000;
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { compatFetch } from "./compat.js";

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
    let aggInflight = null;
    let aggTimer = null;
    let lastAllowlistKey = "";
    // 冷启动预热：读上一次 persist 的磁盘目录当首值（真机取证：全目录拉取烧 20-26s，
    // 首个 candidatesFor 冷等全程）。aggFetchedAt 用磁盘记录的真实时间；get 对
    // 「有旧值」的情形一律 stale-while-revalidate（立即返回 + 后台刷），主请求零等待。
    if (cacheFile) {
      try {
        const raw = JSON.parse(readFileSync(cacheFile, "utf8"));
        if (Array.isArray(raw?.data)) {
          aggregate = { object: "list", data: raw.data };
          aggFetchedAt = Number(raw.cachedAt) || 0;
        }
      } catch { /* 无缓存/坏档：按冷处理 */ }
    }
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
      // 单供应商拉取失败时沿用旧缓存里它的段（取证教训：此前失败=整段消失，
      // 且 2h TTL 内无人再拉（startAutoRefresh 曾是空函数），目录会长期缺一大块）。
      const prevByProvider = new Map();
      for (const m of aggregate?.data || []) {
        const pid = typeof m?.id === "string" ? m.id.split("/")[0] : "";
        if (!pid) continue;
        if (!prevByProvider.has(pid)) prevByProvider.set(pid, []);
        prevByProvider.get(pid).push(m);
      }
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
          // 单供应商取数失败不拖垮整体：有旧数据则保留旧数据
          const prev = prevByProvider.get(p.id);
          if (prev?.length) all.push(...prev);
        }
      }
      aggregate = { object: "list", data: all };
      try {
        lastAllowlistKey = await currentAllowlistKey();
      } catch {}
      if (cacheFile) persistModels(aggregate, cacheFile);
      return aggregate;
    }
    // 对当前 aggregate（含磁盘 stale 值）做白名单二次过滤后返回；过滤失败回原值。
    async function aggSnapshot() {
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
    function aggRefreshInBackground() {
      void aggLoadShared().then(() => { aggFetchedAt = Date.now(); }).catch(() => {});
    }
    async function get() {
      const now = Date.now();
      const fresh = aggregate && now - aggFetchedAt < ttlMs;
      if (fresh) {
        // 热更新白名单：allowlist 变化时，即使命中 TTL 也要重载（否则 clear 后仍返回旧过滤结果）
        try {
          const curKey = await currentAllowlistKey();
          if (curKey !== lastAllowlistKey) {
            const out = await aggLoadShared();
            aggFetchedAt = Date.now();
            return out;
          }
        } catch {}
        return aggSnapshot();
      }
      // 有旧值（含冷启动磁盘 stale）：立即返回 + 后台刷新，主请求零等待。
      // 取证教训：全目录拉取 20-26s，此前冷路径同步阻塞整个首请求。
      if (aggregate) {
        aggRefreshInBackground();
        return aggSnapshot();
      }
      // 完全无值（首次冷跑）：只能等这一趟。
      const out = await aggLoadShared();
      aggFetchedAt = Date.now();
      return out;
    }
    // 并发去重：aggLoad 要遍历全部供应商拉目录（真机实测 20-26s），
    // 无去重时赛马/后台任务并发触发就各烧各的（真机日志实证同窗口重复 3 次）。
    function aggLoadShared() {
      if (aggInflight) return aggInflight;
      aggInflight = (async () => {
        try {
          return await aggLoad();
        } catch (e) {
          // 失败保旧：有旧聚合就回退旧值，绝不让半次刷新把目录清空
          if (aggregate) return aggregate;
          throw e;
        } finally {
          aggInflight = null;
        }
      })();
      return aggInflight;
    }
    function aggStartAutoRefresh(intervalMs = refreshMs) {
      if (aggTimer) return aggStopAutoRefresh;
      aggTimer = setInterval(() => {
        void aggLoadShared().then(() => { aggFetchedAt = Date.now(); }).catch(() => {});
      }, intervalMs);
      aggTimer.unref?.();
      return aggStopAutoRefresh;
    }
    function aggStopAutoRefresh() {
      if (aggTimer) { clearInterval(aggTimer); aggTimer = null; }
    }
    return { get, startAutoRefresh: aggStartAutoRefresh, stopAutoRefresh: aggStopAutoRefresh };
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
    return await compatFetch(url, { headers, signal: controller.signal });
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