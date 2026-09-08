import { defaultStateFile, readState, writeStateImmediate } from "../store.js";

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

// 仅对 opencode 供应商生效：opencode 的模型为裸 id 或 opencode/ 前缀
export function shouldUseGroupForModel(model, { file = defaultStateFile() } = {}) {
  const m = String(model || "").trim();
  if (!m) return getEffectiveUseGroup({ file });
  // 带前缀：判断是否为 opencode
  if (m.includes("/")) {
    const head = m.split("/")[0].trim().toLowerCase();
    if (head === "opencode" || head === "oc") {
      return getEffectiveUseGroup({ file });
    }
    return true; // 其他供应商不受此开关限制
  }
  // 裸 id 视为 opencode
  return getEffectiveUseGroup({ file });
}

export function isUseGroupEnabled({ file } = {}) {
  return getEffectiveUseGroup({ file });
}
