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
  // 即使脏数据，也要检查 mtime 是否被外部（CLI）改过；若改过则合并，避免 CLI 的 providerConfigs 白名单等被 daemon 的 modelErrors 刷盘覆盖
  if (e.data !== null) {
    try {
      const st = statSync(file);
      if (st.mtimeMs === e.mtimeMs) return e.data;
      // mtime 变了，说明外部改过文件
      if (e.dirty) {
        const disk = loadFromDisk(file);
        const diskObj = typeof disk === "object" && disk !== null ? disk : {};
        // 合并：disk 为新基准，e.data 的热数据（modelErrors/modelLatencies/peerStats 等）覆盖回去，但 providerConfigs 等配置以 disk 为准
        const merged = { ...diskObj, ...e.data };
        // 配置类字段以 disk 为准（CLI 改的白名单、keys、port、token 等）
        if (diskObj.providerConfigs !== undefined) merged.providerConfigs = diskObj.providerConfigs;
        if (diskObj.providerKeys !== undefined) merged.providerKeys = diskObj.providerKeys;
        if (diskObj.providerShareKeys !== undefined) merged.providerShareKeys = diskObj.providerShareKeys;
        if (diskObj.port !== undefined) merged.port = diskObj.port;
        if (diskObj.token !== undefined) merged.token = diskObj.token;
        if (diskObj.preferredModel !== undefined) merged.preferredModel = diskObj.preferredModel;
        if (diskObj.modelPicks !== undefined) merged.modelPicks = diskObj.modelPicks;
        e.data = merged;
        e.mtimeMs = st.mtimeMs;
        // 保持 dirty，让热数据下次刷盘时带上合并后的配置
        return e.data;
      }
    } catch {
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
export const providerBaseUrlEnv = (id) => `MSLXDFF_${String(id || "").toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BASE_URL`;

export function loadProviderKeys(id, { file = defaultStateFile() } = {}) {
  const env = (process.env[providerKeyEnv(id)] || "").trim();
  if (env) return [env];
  // 通用供应商的 keys 优先从 providerConfigs 读取
  const configs = readState(file).providerConfigs;
  const cfg = configs && typeof configs === "object" ? configs[id] : undefined;
  if (cfg && typeof cfg === "object" && Array.isArray(cfg.keys)) {
    const list = [...new Set(cfg.keys.filter((x) => typeof x === "string" && x.trim().length))];
    if (list.length) return list;
  }
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

// 供应商 key 瞬时共享开关（ADR-0008）：默认 false；true = 本节点在 outgoing 转发时附带
// 该供应商 key 给组员（瞬时借用，不落盘）。env `MSLXDFF_<ID>_SHARE_KEYS` 可覆盖 state。
export const providerShareEnv = (id) => `MSLXDFF_${String(id || "").toUpperCase().replace(/[^A-Z0-9]/g, "_")}_SHARE_KEYS`;

export function loadProviderShareKeys(id, { file = defaultStateFile() } = {}) {
  const env = process.env[providerShareEnv(id)] || "";
  if (env) return ["1", "true", "on", "yes"].includes(String(env).trim().toLowerCase());
  const map = readState(file).providerShareKeys;
  return !!(map && typeof map === "object" && map[id]);
}

export function saveProviderShareKeys(id, on, { file = defaultStateFile() } = {}) {
  const map = { ...(readState(file).providerShareKeys || {}) };
  if (on) map[id] = true;
  else delete map[id];
  writeStateImmediate(file, { providerShareKeys: map });
  return !!on;
}

// ---- 通用 OpenAI 兼容供应商配置：providerConfigs: { [id]: { baseUrl, keys, allowedModels } } ----
function normalizeBaseUrl(url) {
  const s = String(url || "").trim();
  if (!s) return "";
  return s.replace(/\/+$/, "");
}

function normalizeAllowedModel(model, providerId) {
  let s = String(model || "").trim();
  if (!s) return "";
  // 支持带前缀的输入：bai/glm-5.3-flash -> glm-5.3-flash（仅当 provider 匹配时剥前缀）
  const idx = s.indexOf("/");
  if (idx > 0) {
    const head = s.slice(0, idx).toLowerCase();
    if (head === String(providerId || "").toLowerCase()) s = s.slice(idx + 1);
  }
  return s;
}

export function loadProviderConfigs({ file = defaultStateFile() } = {}) {
  const v = readState(file).providerConfigs;
  if (v && typeof v === "object" && !Array.isArray(v)) return v;
  return {};
}

export function loadProviderConfig(id, { file = defaultStateFile() } = {}) {
  const envUrl = (process.env[providerBaseUrlEnv(id)] || "").trim();
  const envKeys = loadProviderKeys(id, { file });
  // env 覆盖时以 env 为准
  if (envUrl || (process.env[providerKeyEnv(id)] || "").trim()) {
    const baseUrl = envUrl || loadProviderConfigs({ file })[id]?.baseUrl || "";
    const cfg = loadProviderConfigs({ file })[id];
    const allowedModels = cfg && Array.isArray(cfg.allowedModels) ? [...new Set(cfg.allowedModels.map((m) => normalizeAllowedModel(m, id)).filter(Boolean))] : [];
    if (baseUrl || envKeys.length || allowedModels.length) return { baseUrl: normalizeBaseUrl(baseUrl), keys: envKeys, allowedModels };
    return null;
  }
  const configs = loadProviderConfigs({ file });
  const cfg = configs[id];
  if (cfg && typeof cfg === "object") {
    return {
      baseUrl: normalizeBaseUrl(cfg.baseUrl || ""),
      keys: Array.isArray(cfg.keys) ? [...new Set(cfg.keys.filter((x) => typeof x === "string" && x.trim().length))] : [],
      allowedModels: Array.isArray(cfg.allowedModels) ? [...new Set(cfg.allowedModels.map((m) => normalizeAllowedModel(m, id)).filter(Boolean))] : [],
    };
  }
  // 兼容旧 providerKeys 形态：有 key 但无 configs 时视为通用供应商（baseUrl 为空，需后补）
  const keys = loadProviderKeys(id, { file });
  if (keys.length) return { baseUrl: "", keys, allowedModels: [] };
  return null;
}

export function loadProviderBaseUrl(id, opts = {}) {
  const env = (process.env[providerBaseUrlEnv(id)] || "").trim();
  if (env) return normalizeBaseUrl(env);
  const cfg = loadProviderConfigs(opts)[id];
  return cfg && typeof cfg.baseUrl === "string" ? normalizeBaseUrl(cfg.baseUrl) : "";
}

export function saveProviderBaseUrl(id, baseUrl, { file = defaultStateFile() } = {}) {
  const clean = normalizeBaseUrl(baseUrl);
  const configs = { ...loadProviderConfigs({ file }) };
  const cur = configs[id] && typeof configs[id] === "object" ? configs[id] : {};
  const keys = Array.isArray(cur.keys) ? cur.keys : loadProviderKeys(id, { file });
  const allowedModels = Array.isArray(cur.allowedModels) ? [...new Set(cur.allowedModels.map((m) => normalizeAllowedModel(m, id)).filter(Boolean))] : [];
  if (!clean && !keys.length && !allowedModels.length) {
    delete configs[id];
  } else {
    configs[id] = { baseUrl: clean, keys };
    if (allowedModels.length) configs[id].allowedModels = allowedModels;
  }
  writeStateImmediate(file, { providerConfigs: configs });
  return clean;
}

export function saveProviderConfig(id, { baseUrl, keys, allowedModels }, { file = defaultStateFile() } = {}) {
  const cleanUrl = normalizeBaseUrl(baseUrl);
  const cleanKeys = [...new Set((Array.isArray(keys) ? keys : []).map((k) => String(k || "").trim()).filter(Boolean))];
  const cleanAllowed = [...new Set((Array.isArray(allowedModels) ? allowedModels : []).map((m) => normalizeAllowedModel(m, id)).filter(Boolean))];
  const configs = { ...loadProviderConfigs({ file }) };
  const cur = configs[id] && typeof configs[id] === "object" ? configs[id] : {};
  // 保留已有的 allowedModels 若本次未传入
  const finalAllowed = allowedModels === undefined ? (Array.isArray(cur.allowedModels) ? [...new Set(cur.allowedModels.map((m) => normalizeAllowedModel(m, id)).filter(Boolean))] : []) : cleanAllowed;
  if (!cleanUrl && !cleanKeys.length && !finalAllowed.length) {
    delete configs[id];
  } else {
    configs[id] = { baseUrl: cleanUrl, keys: cleanKeys };
    if (finalAllowed.length) configs[id].allowedModels = finalAllowed;
  }
  // 同步清理旧 providerKeys 中同 id 的残留，避免双写
  const oldKeys = readState(file).providerKeys;
  if (oldKeys && typeof oldKeys === "object" && oldKeys[id] !== undefined) {
    const nextKeys = { ...oldKeys };
    delete nextKeys[id];
    writeStateImmediate(file, { providerKeys: nextKeys, providerConfigs: configs });
    return { baseUrl: cleanUrl, keys: cleanKeys, allowedModels: finalAllowed };
  }
  writeStateImmediate(file, { providerConfigs: configs });
  return { baseUrl: cleanUrl, keys: cleanKeys, allowedModels: finalAllowed };
}

// ---- 供应商模型白名单：providerConfigs.<id>.allowedModels（空 = 不限） ----
export function loadProviderAllowedModels(id, { file = defaultStateFile() } = {}) {
  const cfg = loadProviderConfig(id, { file });
  if (cfg && Array.isArray(cfg.allowedModels)) return [...cfg.allowedModels];
  const raw = readState(file).providerConfigs?.[id];
  if (raw && Array.isArray(raw.allowedModels)) return [...new Set(raw.allowedModels.map((m) => normalizeAllowedModel(m, id)).filter(Boolean))];
  return [];
}

export function saveProviderAllowedModels(id, list, { file = defaultStateFile() } = {}) {
  const clean = [...new Set((Array.isArray(list) ? list : []).map((m) => normalizeAllowedModel(m, id)).filter(Boolean))];
  const configs = { ...loadProviderConfigs({ file }) };
  const cur = configs[id] && typeof configs[id] === "object" ? configs[id] : {};
  const baseUrl = normalizeBaseUrl(cur.baseUrl || loadProviderBaseUrl(id, { file }) || "");
  const keys = Array.isArray(cur.keys) ? cur.keys : loadProviderKeys(id, { file });
  if (!baseUrl && !keys.length && !clean.length) {
    delete configs[id];
  } else {
    configs[id] = { baseUrl, keys };
    if (clean.length) configs[id].allowedModels = clean;
  }
  writeStateImmediate(file, { providerConfigs: configs });
  return clean;
}

export function addProviderAllowedModel(id, model, opts = {}) {
  const cur = loadProviderAllowedModels(id, opts);
  const norm = normalizeAllowedModel(model, id);
  if (!norm || cur.includes(norm)) return cur;
  return saveProviderAllowedModels(id, [...cur, norm], opts);
}

export function removeProviderAllowedModel(id, model, opts = {}) {
  return removeProviderAllowedModels(id, [model], opts);
}

export function removeProviderAllowedModels(id, targets = [], opts = {}) {
  const set = new Set((Array.isArray(targets) ? targets : [targets]).map((m) => normalizeAllowedModel(m, id)).filter(Boolean));
  const cur = loadProviderAllowedModels(id, opts);
  const next = cur.filter((m) => !set.has(m));
  return saveProviderAllowedModels(id, next, opts);
}

export function isModelAllowed(id, rawModel, { file = defaultStateFile() } = {}) {
  const raw = String(rawModel || "").trim();
  if (!raw) return true;
  const allowed = loadProviderAllowedModels(id, { file });
  if (!allowed.length) return true;
  const norm = normalizeAllowedModel(raw, id);
  return allowed.includes(norm);
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
