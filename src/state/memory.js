/**
 * memory Store adapter — 零 IO 的 Store 第二实现，证明 Store seam 真实。
 * 与 fileStore（src/state/store.js）共享同一 merge 语义与冷/热分层，
 * 仅将 persist 层替换为 Map<file, {json, mtimeMs}>，不触 `node:fs`。
 * 用于 `—test-concurrency>1` 并行与单测快速路径。
 */
import { mergeState, COLD_WINS } from "./merge.js";

const memCache = new Map(); // file -> { data, dirty, timer, mtimeMs }
const memDisk = new Map(); // file -> { obj, mtimeMs }

function getEntry(file) {
  let e = memCache.get(file);
  if (!e) {
    e = { data: null, dirty: false, timer: null, mtimeMs: 0 };
    memCache.set(file, e);
  }
  return e;
}

function loadFromDiskMem(file) {
  const v = memDisk.get(file);
  return v ? structuredClone(v.obj) : {};
}
function getMtimeMem(file) {
  const v = memDisk.get(file);
  return v ? v.mtimeMs : 0;
}
function atomicWriteSyncMem(file, data) {
  const now = Date.now();
  // ensure monotonic mtime
  const prev = memDisk.get(file)?.mtimeMs || 0;
  const mtime = now <= prev ? prev + 1 : now;
  memDisk.set(file, { obj: structuredClone(data), mtimeMs: mtime });
  return mtime;
}

function readState(file) {
  const e = getEntry(file);
  if (e.data !== null) {
    const mtime = getMtimeMem(file);
    if (mtime === e.mtimeMs) return e.data;
    if (e.dirty) {
      const disk = loadFromDiskMem(file);
      const merged = mergeState(disk || {}, e.data);
      e.data = merged;
      e.mtimeMs = mtime;
      return e.data;
    }
  }
  const disk = loadFromDiskMem(file);
  e.data = disk && typeof disk === "object" ? structuredClone(disk) : {};
  e.mtimeMs = getMtimeMem(file) || Date.now();
  e.dirty = false;
  return e.data;
}

function writeStateImmediate(file, patch) {
  const e = getEntry(file);
  const base = e.data !== null ? e.data : readState(file);
  const merged = { ...base, ...patch };
  e.data = merged;
  e.dirty = false;
  if (e.timer) { clearTimeout(e.timer); e.timer = null; }
  e.mtimeMs = atomicWriteSyncMem(file, merged);
  return merged;
}

function writeStateDeferred(file, patch) {
  const e = getEntry(file);
  const base = e.data !== null ? e.data : readState(file);
  const merged = { ...base, ...patch };
  e.data = merged;
  e.dirty = true;
  // 内存版无需定时刷盘，延迟写即 dirty，下次 flush 或 read 时合并
  return merged;
}

export function flushStateSync(file) {
  const e = memCache.get(file);
  if (!e || !e.dirty || !e.data) return;
  e.mtimeMs = atomicWriteSyncMem(file || "mem://default", e.data);
  e.dirty = false;
  if (e.timer) { clearTimeout(e.timer); e.timer = null; }
}

export function clearStateCache(file) {
  if (file) memCache.delete(file);
  else memCache.clear();
}

// ---- domain 工厂（复用 schemas 的 normalize 逻辑，但闭包于 memory store） ----
// 为保持零依赖，memory 侧直接内联必要的 normalize（如 normalizeAllowedModel）
// 此处仅暴露与 fileStore 对等的最小子集用于测试 seam；完整 facade 可按需扩展

const WORKBUDDY_DEFAULT_BASE_URL = "https://copilot.tencent.com";
function normalizeAllowedModel(model, providerId) {
  let s = String(model || "").trim();
  if (!s) return "";
  const idx = s.indexOf("/");
  if (idx > 0 && s.slice(0, idx).toLowerCase() === String(providerId || "").toLowerCase()) s = s.slice(idx + 1);
  return s;
}
function defaultStateFileMem(file) { return file || "mem://default"; }

export function createMemoryState(file = "mem://default") {
  const f = defaultStateFileMem(file);
  return {
    loadModelErrors: () => {
      const v = readState(f).modelErrors;
      return v && typeof v === "object" && !Array.isArray(v) ? structuredClone(v) : {};
    },
    saveModelErrors: (errors) => { writeStateDeferred(f, { modelErrors: structuredClone(errors) }); return errors; },
    loadModelLatencies: () => {
      const v = readState(f).modelLatencies;
      return v && typeof v === "object" && !Array.isArray(v) ? structuredClone(v) : {};
    },
    saveModelLatencies: (v) => { writeStateDeferred(f, { modelLatencies: structuredClone(v) }); return v; },
    loadProviderKeys: (id) => {
      const keys = readState(f).providerKeys;
      const v = keys && typeof keys === "object" ? keys[id] : undefined;
      if (typeof v === "string") return v.trim() ? [v.trim()] : [];
      if (Array.isArray(v)) return [...new Set(v.filter((x) => typeof x === "string" && x.trim().length))];
      return [];
    },
    saveProviderKeys: (id, list) => {
      const keys = { ...(readState(f).providerKeys || {}) };
      const clean = [...new Set((Array.isArray(list) ? list : []).map((k) => String(k || "").trim()).filter(Boolean))];
      if (clean.length) keys[id] = clean; else delete keys[id];
      writeStateImmediate(f, { providerKeys: keys });
      return clean;
    },
    loadProviderAllowedModels: (id) => {
      const cfg = readState(f).providerConfigs?.[id];
      if (cfg && Array.isArray(cfg.allowedModels)) return [...cfg.allowedModels].map((m) => normalizeAllowedModel(m, id)).filter(Boolean);
      return [];
    },
    saveProviderAllowedModels: (id, list) => {
      const clean = [...new Set((Array.isArray(list) ? list : []).map((m) => normalizeAllowedModel(m, id)).filter(Boolean))];
      const configs = { ...(readState(f).providerConfigs || {}) };
      const cur = configs[id] || {};
      configs[id] = { ...cur, allowedModels: clean };
      if (!clean.length) delete configs[id].allowedModels;
      if (!configs[id].baseUrl && !(configs[id].keys||[]).length && !(configs[id].allowedModels||[]).length) delete configs[id];
      writeStateImmediate(f, { providerConfigs: configs });
      return clean;
    },
    loadPeers: () => {
      const v = readState(f).peers;
      return Array.isArray(v) ? structuredClone(v) : [];
    },
    savePeers: (peers) => { writeStateImmediate(f, { peers: structuredClone(peers) }); return peers; },
    flushSync: () => flushStateSync(f),
    clear: () => clearStateCache(f),
    _memDisk: memDisk,
    _memCache: memCache,
  };
}

// 单例 memory facade（便于直接 import 使用）
export const memoryState = createMemoryState("mem://default");
