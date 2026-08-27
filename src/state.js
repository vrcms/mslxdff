import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import os from "node:os";

export const DEFAULT_PORT = 8989;

export function defaultStateFile() {
  return process.env.MSLXDFF_STATE_FILE ||
    join(os.homedir(), ".config", "mslxdff", "state.json");
}

export function generateToken() {
  return randomBytes(32).toString("hex");
}

// ---- 缓存层：读走内存，写分“热/冷”两档，热数据 500ms 批量刷盘 ----
const stateCache = new Map(); // file -> { data, dirty, timer, mtimeMs }
const FLUSH_MS = (() => {
  const n = Number(process.env.MSLXDFF_STATE_FLUSH_MS);
  return Number.isInteger(n) && n >= 0 ? n : 500;
})();

function getEntry(file) {
  let e = stateCache.get(file);
  if (!e) {
    e = { data: null, dirty: false, timer: null, mtimeMs: 0 };
    stateCache.set(file, e);
  }
  return e;
}

function loadFromDisk(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function readState(file) {
  const e = getEntry(file);
  // 脏数据直接从内存拿，不碰磁盘
  if (e.data !== null && e.dirty) return e.data;
  // 已有干净缓存且文件未变，直接命中
  if (e.data !== null) {
    try {
      const st = statSync(file);
      if (st.mtimeMs === e.mtimeMs) return e.data;
    } catch {
      // 文件不存在等，沿用内存
      if (e.data) return e.data;
    }
  }
  const disk = loadFromDisk(file);
  const obj = typeof disk === "object" && disk !== null ? disk : {};
  e.data = obj;
  try {
    const st = statSync(file);
    e.mtimeMs = st.mtimeMs;
  } catch {
    e.mtimeMs = Date.now();
  }
  e.dirty = false;
  return e.data;
}

function writeStateImmediate(file, patch) {
  const e = getEntry(file);
  const base = e.data !== null ? e.data : readState(file);
  const merged = { ...base, ...patch };
  e.data = merged;
  e.dirty = false;
  if (e.timer) {
    clearTimeout(e.timer);
    e.timer = null;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(merged, null, 2), { mode: 0o600 });
  try {
    e.mtimeMs = statSync(file).mtimeMs;
  } catch {
    e.mtimeMs = Date.now();
  }
  return merged;
}

function scheduleFlush(file) {
  const e = getEntry(file);
  if (e.timer) return;
  if (FLUSH_MS === 0) {
    // 同步刷（测试用）
    flushStateSync(file);
    return;
  }
  e.timer = setTimeout(() => {
    e.timer = null;
    void flushState(file);
  }, FLUSH_MS);
  e.timer.unref?.();
}

async function flushState(file) {
  const e = stateCache.get(file);
  if (!e || !e.dirty || !e.data) return;
  const snapshot = e.data;
  try {
    mkdirSync(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    e.dirty = false;
    try {
      e.mtimeMs = statSync(file).mtimeMs;
    } catch {
      e.mtimeMs = Date.now();
    }
  } catch {
    // 保留 dirty，下次重试
  }
}

function writeStateDeferred(file, patch) {
  const e = getEntry(file);
  const base = e.data !== null ? e.data : readState(file);
  const merged = { ...base, ...patch };
  e.data = merged;
  e.dirty = true;
  scheduleFlush(file);
  return merged;
}

export function flushStateSync(file = defaultStateFile()) {
  const e = stateCache.get(file);
  if (!e || !e.dirty || !e.data) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(e.data, null, 2), { mode: 0o600 });
    e.dirty = false;
    try {
      e.mtimeMs = statSync(file).mtimeMs;
    } catch {
      e.mtimeMs = Date.now();
    }
    if (e.timer) {
      clearTimeout(e.timer);
      e.timer = null;
    }
  } catch {}
}

export function clearStateCache(file) {
  if (file) stateCache.delete(file);
  else stateCache.clear();
}

// ---- 对外 API：冷数据立即落盘，热数据延迟批量 ----

export async function loadToken({ file = defaultStateFile() } = {}) {
  const state = readState(file);
  if (typeof state.token === "string" && state.token.length > 0) {
    return { token: state.token, created: false };
  }
  return { token: writeStateImmediate(file, { token: generateToken(), createdAt: new Date().toISOString() }).token, created: true };
}

export async function refreshToken({ file = defaultStateFile() } = {}) {
  return writeStateImmediate(file, { token: generateToken(), createdAt: new Date().toISOString() }).token;
}

export function setPort(port, { file = defaultStateFile() } = {}) {
  writeStateImmediate(file, { port: Number(port) });
}

export function getPort({ file = defaultStateFile() } = {}) {
  const port = readState(file).port;
  return typeof port === "number" && Number.isInteger(port) && port > 0 ? port : null;
}

export function loadModelErrors({ file = defaultStateFile() } = {}) {
  const errors = readState(file).modelErrors;
  return errors && typeof errors === "object" && !Array.isArray(errors) ? errors : {};
}

export function saveModelErrors(errors, { file = defaultStateFile() } = {}) {
  writeStateDeferred(file, { modelErrors: errors });
  return errors;
}

export function loadModelLatencies({ file = defaultStateFile() } = {}) {
  const lat = readState(file).modelLatencies;
  return lat && typeof lat === "object" && !Array.isArray(lat) ? lat : {};
}

export function saveModelLatencies(latencies, { file = defaultStateFile() } = {}) {
  writeStateDeferred(file, { modelLatencies: latencies });
  return latencies;
}

export function loadPreferredModel({ file = defaultStateFile() } = {}) {
  const v = readState(file).preferredModel;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// 供应商 API key：state 存 `providerKeys: { openrouter: ["sk-1", "sk-2"] }`
// 兼容旧版单字符串 `openrouter: "sk-1"`（读到自动转数组）。
// env `MSLXDFF_<ID>_KEY`（大写）优先，state 兜底；key 为空视为未配置
export const providerKeyEnv = (id) => `MSLXDFF_${String(id || "").toUpperCase().replace(/[^A-Z0-9]/g, "_")}_KEY`;

export function loadProviderKeys(id, { file = defaultStateFile() } = {}) {
  const env = (process.env[providerKeyEnv(id)] || "").trim();
  if (env) return [env];
  const keys = readState(file).providerKeys;
  const v = keys && typeof keys === "object" ? keys[id] : undefined;
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) return [...new Set(v.filter((x) => typeof x === "string" && x.trim().length))];
  return [];
}

export function loadProviderKey(id, opts = {}) {
  return loadProviderKeys(id, opts)[0] || "";
}

export function saveProviderKeys(id, list, { file = defaultStateFile() } = {}) {
  const keys = { ...(readState(file).providerKeys || {}) };
  const clean = [...new Set((Array.isArray(list) ? list : []).map((k) => String(k || "").trim()).filter(Boolean))];
  if (clean.length) keys[id] = clean;
  else delete keys[id];
  writeStateImmediate(file, { providerKeys: keys });
  return clean;
}

export function saveProviderKey(id, key, opts = {}) {
  const list = [...loadProviderKeys(id, opts)];
  const clean = String(key || "").trim();
  if (clean && !list.includes(clean)) list.push(clean);
  return saveProviderKeys(id, clean ? list : [], opts);
}

export function addProviderKey(id, key, opts = {}) {
  return saveProviderKey(id, key, opts);
}

export function removeProviderKey(id, key, opts = {}) {
  return removeProviderKeys(id, [key], opts);
}

export function removeProviderKeys(id, targets = [], opts = {}) {
  const set = new Set((Array.isArray(targets) ? targets : [targets]).map((k) => String(k || "").trim()).filter(Boolean));
  const list = loadProviderKeys(id, opts).filter((k) => !set.has(k));
  return saveProviderKeys(id, list, opts);
}

// 常用模型勾选集（auto 候选池白名单）：空数组 = 不启用筛选（全量 auto）
export function loadModelPicks({ file = defaultStateFile() } = {}) {
  const picks = readState(file).modelPicks;
  if (!Array.isArray(picks)) return [];
  return [...new Set(picks.filter((x) => typeof x === "string" && x.trim().length))];
}

export function saveModelPicks(picks, { file = defaultStateFile() } = {}) {
  const list = [...new Set((Array.isArray(picks) ? picks : []).filter((x) => typeof x === "string" && x.trim().length))];
  writeStateImmediate(file, { modelPicks: list });
  return list;
}

export function savePreferredModel(id, { file = defaultStateFile() } = {}) {
  writeStateImmediate(file, { preferredModel: String(id || "").trim() });
  return String(id || "").trim();
}

export function loadPeers({ file = defaultStateFile() } = {}) {
  const peers = readState(file).peers;
  return Array.isArray(peers) ? peers : [];
}

export function savePeers(peers, { file = defaultStateFile() } = {}) {
  writeStateImmediate(file, { peers });
  return peers;
}

export function loadPeerErrors({ file = defaultStateFile() } = {}) {
  const errors = readState(file).peerErrors;
  return errors && typeof errors === "object" && !Array.isArray(errors) ? errors : {};
}

export function savePeerErrors(errors, { file = defaultStateFile() } = {}) {
  writeStateDeferred(file, { peerErrors: errors });
  return errors;
}

export function loadPeerStats({ file = defaultStateFile() } = {}) {
  const stats = readState(file).peerStats;
  return stats && typeof stats === "object" && !Array.isArray(stats) ? stats : {};
}

export function savePeerStats(stats, { file = defaultStateFile() } = {}) {
  writeStateDeferred(file, { peerStats: stats });
  return stats;
}

export function loadGroups({ file = defaultStateFile() } = {}) {
  const groups = readState(file).groups;
  return groups && typeof groups === "object" && !Array.isArray(groups) ? groups : {};
}

export function loadGroupsJoined({ file = defaultStateFile() } = {}) {
  const joined = readState(file).groupsJoined;
  return Array.isArray(joined) ? joined : [];
}

export function saveGroupsJoined(joined, { file = defaultStateFile() } = {}) {
  writeStateImmediate(file, { groupsJoined: joined });
  return joined;
}

export function loadBans({ file = defaultStateFile() } = {}) {
  const bans = readState(file).bans;
  return bans && typeof bans === "object" && !Array.isArray(bans) ? bans : {};
}

export function saveBans(bans, { file = defaultStateFile() } = {}) {
  writeStateImmediate(file, { bans });
  return bans;
}

export function saveGroups(groups, { file = defaultStateFile() } = {}) {
  writeStateImmediate(file, { groups });
  return groups;
}

function writeState(file, patch) {
  // 兼容旧调用：默认走立即落盘
  return writeStateImmediate(file, patch);
}
