// 模型能力目录服务（opencode 官方同源 models.dev）：fetch + 磁盘缓存 + TTL + staleness 降级
// 源：https://models.opencode.ai/api.json（opencode core models-dev.ts:160 同款；备选 https://models.dev/api.json）
// 形状：{ [providerId]: { models: { [modelId]: raw } } }；mslxdff 裸 id 归 opencode，`prov/id` 前缀路由到对应 provider
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeProviderModels, normalizeWorkbuddyCaps } from "./parse.js";
import { compatFetch } from "../compat.js";

export const DEFAULT_SOURCE_URL = "https://models.opencode.ai/api.json";

export function sourceUrl() {
  const raw = process.env.MSLXDFF_MODELS_DEV_URL;
  return raw && String(raw).trim() ? String(raw).trim() : DEFAULT_SOURCE_URL;
}

export function ttlMs() {
  const n = Number(process.env.MSLXDFF_MODELS_DEV_TTL_MS);
  return Number.isInteger(n) && n >= 0 ? n : 86_400_000; // 默认 24h
}

export function createCapabilitiesService({
  fetchImpl = compatFetch,
  cacheFile = "",
  ttlMs: ttl = ttlMs(),
  url = sourceUrl(),
  now = Date.now,
} = {}) {
  let raw = null;          // 原始目录（全 provider）
  let capsIndex = new Map(); // providerId -> { modelId -> caps }
  let npmIndex = new Map();  // opencode 裸 modelId -> provider.npm（responses 判定用；null = 继承默认）
  let loadedAt = 0;
  let inflight = null;

  function buildIndex(data) {
    const idx = new Map();
    const npm = new Map();
    for (const [pid, p] of Object.entries(data || {})) {
      if (!p || typeof p !== "object") continue;
      const caps = normalizeProviderModels(p.models || {});
      idx.set(pid, caps);
      if (String(pid).toLowerCase() === "opencode") {
        for (const [mid, c] of Object.entries(caps)) npm.set(mid, c.npm ?? null);
      }
    }
    npmIndex = npm;
    return idx;
  }

  function readCache() {
    if (!cacheFile) return null;
    try { return JSON.parse(readFileSync(cacheFile, "utf8")); } catch { return null; }
  }

  function writeCache(data) {
    if (!cacheFile || !data) return;
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(data));
    } catch { /* 缓存失败不致命 */ }
  }

  async function fetchFresh() {
    const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!res?.ok) throw new Error(`models.dev fetch ${res?.status || "network"}`);
    return res.json();
  }

  // ready：缓存新鲜直接用；否则拉新；失败回退旧缓存（含磁盘），完全无数据才抛
  async function ready() {
    const t = now();
    if (raw && t - loadedAt < ttl) return;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const data = await fetchFresh();
        raw = data;
        capsIndex = buildIndex(data);
        loadedAt = t;
        writeCache(data);
      } catch (e) {
        if (raw) return; // 内存还有旧的，继续用
        const disk = readCache();
        if (disk) {
          raw = disk;
          capsIndex = buildIndex(disk);
          loadedAt = t; // 视作刚加载，避免每请求都重试打上游
          return;
        }
        throw e;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function capsFor(pid) {
    return capsIndex.get(pid) || null;
  }

  function get(providerId, modelId) {
    const pid = String(providerId || "opencode").toLowerCase();
    const mid = String(modelId || "");
    const map = capsFor(pid);
    if (!map) return null;
    return map[mid] || null;
  }

  function list(providerId) {
    const pid = String(providerId || "opencode").toLowerCase();
    const map = capsFor(pid);
    if (!map) return [];
    return Object.entries(map).map(([id, capabilities]) => ({ id, capabilities }));
  }

  function providers() {
    return [...capsIndex.keys()].sort();
  }

  return { ready, get, list, providers, npmIndex: () => new Map(npmIndex) };
}

// 模块级单例：HTTP handler 懒加载，测试 _reset 后注入
let _global = null;
export function globalCapabilities() {
  if (!_global) _global = createCapabilitiesService({ cacheFile: defaultCacheFile() });
  return _global;
}
export function _resetGlobalCapabilities() { _global = null; }

// 缓存落盘位置：MSLXDFF_MODELS_DEV_CACHE 覆盖 > ~/.config/mslxdff/models-dev.json（与 state 同目录）
function defaultCacheFile() {
  const override = process.env.MSLXDFF_MODELS_DEV_CACHE;
  if (override && String(override).trim()) return String(override).trim();
  return join(homedir(), ".config", "mslxdff", "models-dev.json");
}

// workbuddy 动态源：从聚合模型服务（models.get()，带 10min 上游缓存）拉 workbuddy/ 前缀条目
// → 统一 caps 形状 map（{ rawId -> caps }）。上游原生字段 first-party 最准，不走 models.dev。
export function workbuddyCapsFromModels(getModels, normalizeFn) {
  const normalize = normalizeFn || ((m) => normalizeWorkbuddyCaps(m.id, m));
  return async () => {
    const agg = await getModels();
    const all = Array.isArray(agg?.data) ? agg.data : [];
    const map = {};
    for (const entry of all) {
      const id = String(entry?.id || "");
      if (!id.toLowerCase().startsWith("workbuddy/")) continue;
      const raw = id.slice("workbuddy/".length);
      if (!raw) continue;
      map[raw] = normalize(entry);
    }
    return map;
  };
}

// workbuddy provider 单例（直连上游 listModels 自带 10min 缓存）：HTTP handler 与
// -setto opencode 能力注入共享同一个实例，避免双份连接池/缓存。
let _wbProv = null;
export function _resetWorkbuddyProv() { _wbProv = null; }
export async function workbuddyAllModels() {
  if (!_wbProv) {
    const { createWorkbuddyProvider } = await import("../providers/workbuddy.js");
    const { defaultStateFile } = await import("../state.js");
    _wbProv = createWorkbuddyProvider({ file: defaultStateFile() });
  }
  const list = await _wbProv.listModels();
  return { object: "list", data: Array.isArray(list) ? list : [] };
}
