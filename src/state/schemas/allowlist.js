import { defaultStateFile, readState, writeStateImmediate } from "../store.js";
import {
  normalizeAllowedModel,
  normalizeBaseUrl,
  normalizeAuths,
  normalizeEndpointPath,
  loadProviderConfigs,
  loadProviderConfig,
  loadProviderBaseUrl,
  loadProviderKeys,
} from "./provider.js";

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
  const auths = normalizeAuths(cur.auths);
  const modelsPath = typeof cur.modelsPath === "string" ? normalizeEndpointPath(cur.modelsPath) : "";
  const chatPath = typeof cur.chatPath === "string" ? normalizeEndpointPath(cur.chatPath) : "";
  // allowAnyModels 是独立语义开关：只有它也设过时，即使其余字段全空也不能整键删（否则 clear 会把「允许任意」连带抹掉，供应商从放行降级成全拦 403）
  if (!baseUrl && !keys.length && !auths.length && !clean.length && !modelsPath && !chatPath && typeof cur.allowAnyModels !== "boolean") {
    delete configs[id];
  } else {
    configs[id] = { baseUrl, keys };
    // 重建 cfg 是 `{ baseUrl, keys }` 起手，不显式带 allowAnyModels 就会静默丢用户的「允许任意」设置
    // （实测 2026-09-24：saveProviderAllowedModels 把 allowAnyModels:true 抹成默认 false）。
    // cline 白名单 auto-sync 会周期性写这里，丢了就是持续丢，必须保留。
    if (typeof cur.allowAnyModels === "boolean") configs[id].allowAnyModels = cur.allowAnyModels;
    if (auths.length) configs[id].auths = auths;
    if (clean.length) configs[id].allowedModels = clean;
    if (modelsPath) configs[id].modelsPath = modelsPath;
    if (chatPath) configs[id].chatPath = chatPath;
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

function normalizeAllowAny(v, id) {
  if (typeof v === "boolean") return v;
  if (String(id || "").toLowerCase() === "opencode") return true;
  return false;
}
export function loadProviderAllowAnyModels(id, { file = defaultStateFile() } = {}) {
  const cfg = readState(file).providerConfigs?.[id];
  if (cfg && typeof cfg.allowAnyModels === "boolean") return cfg.allowAnyModels;
  return normalizeAllowAny(undefined, id);
}
export function saveProviderAllowAnyModels(id, allowAny, { file = defaultStateFile() } = {}) {
  const state = readState(file);
  const cfgs = { ...(state.providerConfigs || {}) };
  const cur = cfgs[id] || {};
  cfgs[id] = { ...cur, allowAnyModels: normalizeAllowAny(allowAny, id) };
  writeStateImmediate(file, { providerConfigs: cfgs });
  return cfgs[id].allowAnyModels;
}
export function isModelAllowed(id, rawModel, { file = defaultStateFile() } = {}) {
  const raw = String(rawModel || "").trim();
  if (!raw) return true;
  const allowed = loadProviderAllowedModels(id, { file });
  const allowAny = loadProviderAllowAnyModels(id, { file });
  if (!allowed.length) return allowAny;
  const norm = normalizeAllowedModel(raw, id);
  return allowed.includes(norm);
}
