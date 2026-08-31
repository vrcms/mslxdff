import { defaultStateFile, readState, writeStateImmediate } from "../store.js";

export const WORKBUDDY_DEFAULT_BASE_URL = "https://copilot.tencent.com";

export function normalizeBaseUrl(url) {
  const s = String(url || "").trim();
  if (!s) return "";
  return s.replace(/\/+$/, "");
}
export function normalizeAuths(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list) {
    if (!a || typeof a !== "object") continue;
    const uid = String(a.uid || a.userId || "").trim();
    if (!uid) continue;
    out.push({
      uid,
      domain: String(a.domain || "www.codebuddy.cn").trim() || "www.codebuddy.cn",
      enterpriseId: String(a.enterpriseId || a.enterprise_id || "").trim(),
      refreshToken: String(a.refreshToken || a.refresh_token || "").trim(),
    });
  }
  return out;
}
export function normalizeAllowedModel(model, providerId) {
  let s = String(model || "").trim();
  if (!s) return "";
  const idx = s.indexOf("/");
  if (idx > 0) {
    const head = s.slice(0, idx).toLowerCase();
    if (head === String(providerId || "").toLowerCase()) s = s.slice(idx + 1);
  }
  return s;
}
export function normalizeEndpointPath(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  return s.startsWith("/") ? s : `/${s}`;
}
export function defaultModelsPath(id) {
  if (String(id).toLowerCase() === "workbuddy") return "/console/enterprises/personal/models";
  return "/models";
}
export function defaultChatPath(id) {
  if (String(id).toLowerCase() === "workbuddy") return "/v2/chat/completions";
  return "/chat/completions";
}
export function loadProviderModelsPath(id, { file = defaultStateFile() } = {}) {
  const cfg = loadProviderConfigs({ file })[id];
  if (cfg && typeof cfg.modelsPath === "string" && cfg.modelsPath.trim()) return normalizeEndpointPath(cfg.modelsPath);
  return defaultModelsPath(id);
}
export function loadProviderChatPath(id, { file = defaultStateFile() } = {}) {
  const cfg = loadProviderConfigs({ file })[id];
  if (cfg && typeof cfg.chatPath === "string" && cfg.chatPath.trim()) return normalizeEndpointPath(cfg.chatPath);
  return defaultChatPath(id);
}

export const providerKeyEnv = (id) => `MSLXDFF_${String(id || "").toUpperCase().replace(/[^A-Z0-9]/g, "_")}_KEY`;
export const providerBaseUrlEnv = (id) => `MSLXDFF_${String(id || "").toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BASE_URL`;
export const providerShareEnv = (id) => `MSLXDFF_${String(id || "").toUpperCase().replace(/[^A-Z0-9]/g, "_")}_SHARE_KEYS`;

export function loadProviderKeys(id, { file = defaultStateFile() } = {}) {
  const env = (process.env[providerKeyEnv(id)] || "").trim();
  if (env) return [env];
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

export function loadProviderConfigs({ file = defaultStateFile() } = {}) {
  const v = readState(file).providerConfigs;
  if (v && typeof v === "object" && !Array.isArray(v)) return v;
  return {};
}

export function loadProviderConfig(id, { file = defaultStateFile() } = {}) {
  const envUrl = (process.env[providerBaseUrlEnv(id)] || "").trim();
  const envKeys = loadProviderKeys(id, { file });
  if (envUrl || (process.env[providerKeyEnv(id)] || "").trim()) {
    const baseUrl = envUrl || loadProviderConfigs({ file })[id]?.baseUrl || (String(id).toLowerCase() === "workbuddy" ? WORKBUDDY_DEFAULT_BASE_URL : "");
    const cfg = loadProviderConfigs({ file })[id];
    const allowedModels = cfg && Array.isArray(cfg.allowedModels) ? [...new Set(cfg.allowedModels.map((m) => normalizeAllowedModel(m, id)).filter(Boolean))] : [];
    const auths = cfg && Array.isArray(cfg.auths) ? normalizeAuths(cfg.auths) : [];
    const modelsPath = cfg && typeof cfg.modelsPath === "string" && cfg.modelsPath.trim() ? normalizeEndpointPath(cfg.modelsPath) : defaultModelsPath(id);
    const chatPath = cfg && typeof cfg.chatPath === "string" && cfg.chatPath.trim() ? normalizeEndpointPath(cfg.chatPath) : defaultChatPath(id);
    if (baseUrl || envKeys.length || allowedModels.length || auths.length) return { baseUrl: normalizeBaseUrl(baseUrl), keys: envKeys, auths, allowedModels, modelsPath, chatPath };
    return null;
  }
  const configs = loadProviderConfigs({ file });
  const cfg = configs[id];
  if (cfg && typeof cfg === "object") {
    return {
      baseUrl: normalizeBaseUrl(cfg.baseUrl || (String(id).toLowerCase() === "workbuddy" ? WORKBUDDY_DEFAULT_BASE_URL : "")),
      keys: Array.isArray(cfg.keys) ? [...new Set(cfg.keys.filter((x) => typeof x === "string" && x.trim().length))] : [],
      auths: normalizeAuths(cfg.auths),
      allowedModels: Array.isArray(cfg.allowedModels) ? [...new Set(cfg.allowedModels.map((m) => normalizeAllowedModel(m, id)).filter(Boolean))] : [],
      modelsPath: typeof cfg.modelsPath === "string" && cfg.modelsPath.trim() ? normalizeEndpointPath(cfg.modelsPath) : defaultModelsPath(id),
      chatPath: typeof cfg.chatPath === "string" && cfg.chatPath.trim() ? normalizeEndpointPath(cfg.chatPath) : defaultChatPath(id),
    };
  }
  const keys = loadProviderKeys(id, { file });
  if (keys.length) return { baseUrl: String(id).toLowerCase() === "workbuddy" ? WORKBUDDY_DEFAULT_BASE_URL : "", keys, auths: [], allowedModels: [], modelsPath: defaultModelsPath(id), chatPath: defaultChatPath(id) };
  return null;
}

export function loadProviderBaseUrl(id, opts = {}) {
  const env = (process.env[providerBaseUrlEnv(id)] || "").trim();
  if (env) return normalizeBaseUrl(env);
  const cfg = loadProviderConfigs(opts)[id];
  if (cfg && typeof cfg.baseUrl === "string" && normalizeBaseUrl(cfg.baseUrl)) return normalizeBaseUrl(cfg.baseUrl);
  if (String(id || "").toLowerCase() === "workbuddy") return WORKBUDDY_DEFAULT_BASE_URL;
  return "";
}

export function loadProviderAuths(id, { file = defaultStateFile() } = {}) {
  const cfg = loadProviderConfigs({ file })[id];
  if (cfg && Array.isArray(cfg.auths)) return normalizeAuths(cfg.auths);
  return [];
}
export function saveProviderAuths(id, list, { file = defaultStateFile() } = {}) {
  const clean = normalizeAuths(list);
  const configs = { ...loadProviderConfigs({ file }) };
  const cur = configs[id] && typeof configs[id] === "object" ? configs[id] : {};
  const baseUrl = normalizeBaseUrl(cur.baseUrl || loadProviderBaseUrl(id, { file }) || "");
  const keys = Array.isArray(cur.keys) ? [...new Set(cur.keys.filter((x) => typeof x === "string" && x.trim().length))] : loadProviderKeys(id, { file });
  const allowedModels = Array.isArray(cur.allowedModels) ? [...new Set(cur.allowedModels.map((m) => normalizeAllowedModel(m, id)).filter(Boolean))] : [];
  const modelsPath = typeof cur.modelsPath === "string" ? normalizeEndpointPath(cur.modelsPath) : "";
  const chatPath = typeof cur.chatPath === "string" ? normalizeEndpointPath(cur.chatPath) : "";
  if (!baseUrl && !keys.length && !clean.length && !allowedModels.length && !modelsPath && !chatPath) {
    delete configs[id];
  } else {
    configs[id] = { baseUrl, keys };
    if (clean.length) configs[id].auths = clean;
    if (allowedModels.length) configs[id].allowedModels = allowedModels;
    if (modelsPath) configs[id].modelsPath = modelsPath;
    if (chatPath) configs[id].chatPath = chatPath;
  }
  writeStateImmediate(file, { providerConfigs: configs });
  return clean;
}

export function saveProviderBaseUrl(id, baseUrl, { file = defaultStateFile() } = {}) {
  const clean = normalizeBaseUrl(baseUrl);
  const configs = { ...loadProviderConfigs({ file }) };
  const cur = configs[id] && typeof configs[id] === "object" ? configs[id] : {};
  const keys = Array.isArray(cur.keys) ? cur.keys : loadProviderKeys(id, { file });
  const auths = normalizeAuths(cur.auths);
  const allowedModels = Array.isArray(cur.allowedModels) ? [...new Set(cur.allowedModels.map((m) => normalizeAllowedModel(m, id)).filter(Boolean))] : [];
  const modelsPath = typeof cur.modelsPath === "string" ? normalizeEndpointPath(cur.modelsPath) : "";
  const chatPath = typeof cur.chatPath === "string" ? normalizeEndpointPath(cur.chatPath) : "";
  if (!clean && !keys.length && !auths.length && !allowedModels.length && !modelsPath && !chatPath) {
    delete configs[id];
  } else {
    configs[id] = { baseUrl: clean, keys };
    if (auths.length) configs[id].auths = auths;
    if (allowedModels.length) configs[id].allowedModels = allowedModels;
    if (modelsPath) configs[id].modelsPath = modelsPath;
    if (chatPath) configs[id].chatPath = chatPath;
  }
  writeStateImmediate(file, { providerConfigs: configs });
  return clean;
}

export function saveProviderConfig(id, { baseUrl, keys, auths, allowedModels, modelsPath, chatPath }, { file = defaultStateFile() } = {}) {
  const cleanUrl = normalizeBaseUrl(baseUrl);
  const cleanKeys = [...new Set((Array.isArray(keys) ? keys : []).map((k) => String(k || "").trim()).filter(Boolean))];
  const cleanAuths = auths === undefined ? undefined : normalizeAuths(auths);
  const cleanAllowed = [...new Set((Array.isArray(allowedModels) ? allowedModels : []).map((m) => normalizeAllowedModel(m, id)).filter(Boolean))];
  const cleanModelsPath = modelsPath === undefined ? undefined : (String(modelsPath).trim() ? normalizeEndpointPath(modelsPath) : "");
  const cleanChatPath = chatPath === undefined ? undefined : (String(chatPath).trim() ? normalizeEndpointPath(chatPath) : "");
  const configs = { ...loadProviderConfigs({ file }) };
  const cur = configs[id] && typeof configs[id] === "object" ? configs[id] : {};
  const finalAllowed = allowedModels === undefined ? (Array.isArray(cur.allowedModels) ? [...new Set(cur.allowedModels.map((m) => normalizeAllowedModel(m, id)).filter(Boolean))] : []) : cleanAllowed;
  const finalAuths = cleanAuths === undefined ? normalizeAuths(cur.auths) : cleanAuths;
  const finalModelsPath = cleanModelsPath === undefined ? (typeof cur.modelsPath === "string" ? normalizeEndpointPath(cur.modelsPath) : "") : cleanModelsPath;
  const finalChatPath = cleanChatPath === undefined ? (typeof cur.chatPath === "string" ? normalizeEndpointPath(cur.chatPath) : "") : cleanChatPath;
  if (!cleanUrl && !cleanKeys.length && !finalAllowed.length && !finalAuths.length && !finalModelsPath && !finalChatPath) {
    delete configs[id];
  } else {
    configs[id] = { baseUrl: cleanUrl, keys: cleanKeys };
    if (finalAuths.length) configs[id].auths = finalAuths;
    if (finalAllowed.length) configs[id].allowedModels = finalAllowed;
    if (finalModelsPath) configs[id].modelsPath = finalModelsPath;
    if (finalChatPath) configs[id].chatPath = finalChatPath;
  }
  const oldKeys = readState(file).providerKeys;
  if (oldKeys && typeof oldKeys === "object" && oldKeys[id] !== undefined) {
    const nextKeys = { ...oldKeys };
    delete nextKeys[id];
    writeStateImmediate(file, { providerKeys: nextKeys, providerConfigs: configs });
    return { baseUrl: cleanUrl, keys: cleanKeys, auths: finalAuths, allowedModels: finalAllowed, modelsPath: finalModelsPath, chatPath: finalChatPath };
  }
  writeStateImmediate(file, { providerConfigs: configs });
  return { baseUrl: cleanUrl, keys: cleanKeys, auths: finalAuths, allowedModels: finalAllowed, modelsPath: finalModelsPath, chatPath: finalChatPath };
}
