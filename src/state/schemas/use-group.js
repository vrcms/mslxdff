import { defaultStateFile, readState, writeStateImmediate } from "../store.js";
import { classifyProvider } from "../../providers/classify.js";

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

// 全局开关：off 则所有供应商都不走组员网络（via-route/hedge/peer/broadband 全禁），仅本机直连
// workbuddy 硬禁组员（ADR-0015 local-only）：本机账号绑定（auths/workbuddy-*.json + uid），
// 组员没有该账号转过去也用不了，且本地直连最快——无论全局开关一律仅本机直连。
// model 兼容 canonical（workbuddy/xxx）与 dash（workbuddy-xxx）两种形态。
export function isHardLocalOnly(model) {
  const s = String(model || "").trim().toLowerCase();
  const slash = s.indexOf("/");
  const head = slash > 0 ? s.slice(0, slash) : s.split("-")[0];
  try {
    return classifyProvider(head) === "local-only";
  } catch {
    return head === "workbuddy";
  }
}

export function shouldUseGroupForModel(model, { file = defaultStateFile() } = {}) {
  if (isHardLocalOnly(model)) return false;
  return getEffectiveUseGroup({ file });
}

export function isUseGroupEnabled({ file } = {}) {
  return getEffectiveUseGroup({ file });
}
