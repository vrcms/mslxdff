import { defaultStateFile, readState, writeStateImmediate } from "../store.js";
import { classifyProvider } from "../../providers/classify.js";
import { getModelAlias, normalizeProviderId, DEFAULT_PROVIDER } from "../../providers/model-id.js";

function parseBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["0", "false", "off", "no", "disable", "disabled", "close", "closed"].includes(s)) return false;
    if (["1", "true", "on", "yes", "enable", "enabled", "open"].includes(s)) return true;
  }
  return null;
}

export function loadUseGroup({ file = defaultStateFile() } = {}) {
  const raw = readState(file).useGroup;
  const parsed = parseBool(raw);
  return parsed === null ? true : parsed; // 默认开
}

export function saveUseGroup(value, { file = defaultStateFile() } = {}) {
  const b = Boolean(value);
  writeStateImmediate(file, { useGroup: b });
  return b;
}

export function getUseGroupEnv() {
  const raw = process.env.MSLXDFF_USE_GROUP;
  if (raw === undefined || raw === null || raw === "") return null;
  return parseBool(raw);
}

export function getEffectiveUseGroup({ file = defaultStateFile() } = {}) {
  const env = getUseGroupEnv();
  if (env !== null) return env;
  return loadUseGroup({ file });
}

// key 供应商组员开关：默认 off（仅 opencode 免费池走 peer 兜底，其他带 key 上游恒直连）。
// MSLXDFF_USE_GROUP_KEYS=1/on 可显式开回来（调试/弱网应急）；同样受全局 off 约束。
export function getUseGroupKeysEnv() {
  const raw = process.env.MSLXDFF_USE_GROUP_KEYS;
  if (raw === undefined || raw === null || raw === "") return false;
  return parseBool(raw) === true;
}

// 取模型对应的供应商 head：兼容 canonical（workbuddy/xxx、clinebot/xxx）、
// dash 别名（clinebot-xxx → 还原后取 head）、裸 id（归 opencode）。
// oc/ 别名归一到 opencode（与 splitModelId 一致：别名表小写 key，先小写再归一）。
export function providerHeadOf(model) {
  let s = String(model || "").trim();
  if (!s) return "";
  try {
    const aliased = getModelAlias(s);
    if (aliased) s = aliased;
  } catch {}
  const slash = s.indexOf("/");
  if (slash > 0) {
    try {
      const head = normalizeProviderId(s.slice(0, slash).toLowerCase());
      return String(head || "").toLowerCase();
    } catch {
      return s.slice(0, slash).toLowerCase();
    }
  }
  return DEFAULT_PROVIDER;
}

// 全局开关：off 则所有供应商都不走组员网络（via-route/hedge/peer/broadband 全禁），仅本机直连
// workbuddy/cline 系硬禁组员（ADR-0015 local-only）：本机账号绑定（workbuddy auths/*.json + uid / cline refreshToken），
// 组员没有该账号转过去也用不了，且本地直连最快——无论全局开关一律仅本机直连。
// model 兼容 canonical（workbuddy/xxx、clinebot/xxx）与 dash（workbuddy-xxx、cline-xxx）两种形态。
export function isHardLocalOnly(model) {
  const head = providerHeadOf(model);
  if (!head) return false;
  try {
    return classifyProvider(head) === "local-only";
  } catch {
    return head === "workbuddy" || head === "cline" || head === "clinebot";
  }
}

// key 供应商默认直连（ADR-0023）：opencode（quota-pool，裸 id/oc 前缀）沿用全局开关；
// 其余带前缀的一律仅本机直连，除非 MSLXDFF_USE_GROUP_KEYS=1 显式开回。
export function isKeyProviderDirectOnly(model) {
  const head = providerHeadOf(model);
  if (!head || head === "opencode") return false;
  if (isHardLocalOnly(model)) return true;
  if (getUseGroupKeysEnv()) return false;
  return true;
}

export function shouldUseGroupForModel(model, { file = defaultStateFile() } = {}) {
  if (isHardLocalOnly(model)) return false;
  if (isKeyProviderDirectOnly(model)) return false;
  return getEffectiveUseGroup({ file });
}

export function isUseGroupEnabled({ file } = {}) {
  return getEffectiveUseGroup({ file });
}
