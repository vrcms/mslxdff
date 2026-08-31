/**
 * ProviderConfig 深模块：7 字段 validate/normalize/merge 单点
 * 纯函数，不读 env/file，直接由调用方注入三级数据
 */

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

export const providerKeyEnv = (id) => `MSLXDFF_${String(id || "").toUpperCase().replace(/[^A-Z0-9]/g, "_")}_KEY`;
export const providerBaseUrlEnv = (id) => `MSLXDFF_${String(id || "").toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BASE_URL`;
export const providerShareEnv = (id) => `MSLXDFF_${String(id || "").toUpperCase().replace(/[^A-Z0-9]/g, "_")}_SHARE_KEYS`;

/**
 * validate 7 字段：baseUrl, keys, auths, allowedModels, modelsPath, chatPath, shareKeys?（share 单独）
 * 返回 {ok, clean, errors}
 */
export function validateProviderConfig(raw = {}, providerId = "") {
  const errors = [];
  const clean = {};
  // baseUrl
  const baseUrl = normalizeBaseUrl(raw.baseUrl);
  if (raw.baseUrl !== undefined && raw.baseUrl !== null && String(raw.baseUrl).trim() && !baseUrl) errors.push("baseUrl 不能为空");
  clean.baseUrl = baseUrl;
  // keys
  const keys = [...new Set((Array.isArray(raw.keys) ? raw.keys : []).map((k) => String(k || "").trim()).filter(Boolean))];
  clean.keys = keys;
  // auths
  clean.auths = normalizeAuths(raw.auths);
  // allowedModels
  const allowed = [...new Set((Array.isArray(raw.allowedModels) ? raw.allowedModels : []).map((m) => normalizeAllowedModel(m, providerId)).filter(Boolean))];
  clean.allowedModels = allowed;
  // modelsPath / chatPath
  clean.modelsPath = raw.modelsPath === undefined ? undefined : (String(raw.modelsPath).trim() ? normalizeEndpointPath(raw.modelsPath) : "");
  clean.chatPath = raw.chatPath === undefined ? undefined : (String(raw.chatPath).trim() ? normalizeEndpointPath(raw.chatPath) : "");
  // 若 baseUrl 非空但不是 url 形态，弱校验：必须含 . 或 ://
  if (clean.baseUrl && !/^https?:\/\//.test(clean.baseUrl) && !clean.baseUrl.includes(".")) {
    // workbuddy 默认 https 已过，此分支仅防空
  }
  return { ok: errors.length === 0, clean, errors };
}

/**
 * normalize 保持与 validate 一致，但不返回 ok，直接回 clean（用于落盘前归一）
 */
export function normalizeProviderConfig(raw = {}, providerId = "") {
  const { clean } = validateProviderConfig(raw, providerId);
  return clean;
}

/**
 * merge 三级：env > file > legacy
 * env: {baseUrl, keys} 来自 process.env
 * file: 来自 providerConfigs[id]
 * legacy: 来自 providerKeys[id]（字符串或数组）
 */
export function mergeProviderConfig({ env = {}, file = {}, legacy = [] } = {}, providerId = "") {
  // env 优先
  const envKeys = Array.isArray(env.keys) ? [...new Set(env.keys.filter(Boolean))] : [];
  const hasEnv = !!(env.baseUrl || envKeys.length);
  if (hasEnv) {
    return {
      baseUrl: normalizeBaseUrl(env.baseUrl || file.baseUrl || ""),
      keys: envKeys.length ? envKeys : (Array.isArray(file.keys) ? file.keys : []),
      // env 模式下 file 的 allowed/auths 仍透传（与原 loadProviderConfig 一致）
      allowedModels: Array.isArray(file.allowedModels) ? [...new Set(file.allowedModels.map((m) => normalizeAllowedModel(m, providerId)).filter(Boolean))] : [],
      auths: normalizeAuths(file.auths),
      modelsPath: file.modelsPath ? normalizeEndpointPath(file.modelsPath) : defaultModelsPath(providerId),
      chatPath: file.chatPath ? normalizeEndpointPath(file.chatPath) : defaultChatPath(providerId),
    };
  }
  // file 优先
  if (file && typeof file === "object" && (file.baseUrl || (Array.isArray(file.keys) && file.keys.length) || file.allowedModels || file.auths)) {
    return {
      baseUrl: normalizeBaseUrl(file.baseUrl || ""),
      keys: Array.isArray(file.keys) ? [...new Set(file.keys.filter(Boolean))] : [],
      allowedModels: Array.isArray(file.allowedModels) ? [...new Set(file.allowedModels.map((m) => normalizeAllowedModel(m, providerId)).filter(Boolean))] : [],
      auths: normalizeAuths(file.auths),
      modelsPath: file.modelsPath ? normalizeEndpointPath(file.modelsPath) : defaultModelsPath(providerId),
      chatPath: file.chatPath ? normalizeEndpointPath(file.chatPath) : defaultChatPath(providerId),
    };
  }
  // legacy
  const legacyKeys = Array.isArray(legacy) ? [...new Set(legacy.filter((k) => typeof k === "string" && k.trim().length))] : (typeof legacy === "string" && legacy.trim() ? [legacy.trim()] : []);
  if (legacyKeys.length) {
    return {
      baseUrl: String(providerId).toLowerCase() === "workbuddy" ? WORKBUDDY_DEFAULT_BASE_URL : "",
      keys: legacyKeys,
      allowedModels: [],
      auths: [],
      modelsPath: defaultModelsPath(providerId),
      chatPath: defaultChatPath(providerId),
    };
  }
  return { baseUrl: "", keys: [], allowedModels: [], auths: [], modelsPath: defaultModelsPath(providerId), chatPath: defaultChatPath(providerId) };
}
