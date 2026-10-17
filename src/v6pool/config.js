// v6pool · 配置解析：env 优先，缺省值集中一处；纯函数，便于单测。
import { join } from "node:path";
import { logDir } from "../logs.js";

/**
 * 缺省**开** + **自动判断**：本机有整段路由的 IPv6 前缀就启用（判据见 detect.js），
 * 没有就诚实跳过（行为与今天完全一致）。判据不靠 env，靠事实。
 */
export const DEFAULTS = {
  enabled: true,
  count: 4,
  strategy: "session",
  cooldownMs: 600_000,
  rotate: true,
  minHostBits: 8,
  claim: "auto",
  probePath: "/zen/v1/models",
  retireMs: 60_000,
  debug: false,
};

const OFF = ["0", "off", "false", "no", "disable", "disabled"];
const CLAIM_MODES = ["auto", "bind", "add"];

function envBool(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  return !OFF.includes(String(raw).trim().toLowerCase());
}

function envInt(env, name, fallback) {
  const v = Number(env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

function envStr(env, name, fallback) {
  const raw = env[name];
  return typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
}

/**
 * 解析 v6 出口池配置。
 * @param {Record<string,string|undefined>} env
 * @param {{ logDirFn?: () => string }} [deps] 测试可注入 logDir
 */
export function resolveV6Config(env = process.env, { logDirFn = logDir } = {}) {
  const strategy = envStr(env, "MSLXDFF_V6_STRATEGY", DEFAULTS.strategy) === "request" ? "request" : "session";
  const claimRaw = envStr(env, "MSLXDFF_V6_CLAIM", DEFAULTS.claim).toLowerCase();
  return {
    enabled: envBool(env, "MSLXDFF_V6_POOL", DEFAULTS.enabled),
    /** 显式池前缀（`2001:db8::/64`）；空 = 取本机全局地址的前缀 */
    prefix: envStr(env, "MSLXDFF_V6_PREFIX", ""),
    iface: envStr(env, "MSLXDFF_V6_IFACE", ""),
    count: envInt(env, "MSLXDFF_V6_COUNT", DEFAULTS.count),
    strategy,
    cooldownMs: envInt(env, "MSLXDFF_V6_COOLDOWN_MS", DEFAULTS.cooldownMs),
    rotate: envBool(env, "MSLXDFF_V6_ROTATE", DEFAULTS.rotate),
    minHostBits: envInt(env, "MSLXDFF_V6_MIN_HOST_BITS", DEFAULTS.minHostBits),
    claim: CLAIM_MODES.includes(claimRaw) ? claimRaw : DEFAULTS.claim,
    dir: envStr(env, "MSLXDFF_V6_DIR", join(logDirFn(), "v6pool")),
    probePath: envStr(env, "MSLXDFF_V6_PROBE_PATH", DEFAULTS.probePath),
    retireMs: envInt(env, "MSLXDFF_V6_RETIRE_MS", DEFAULTS.retireMs),
    debug: envBool(env, "MSLXDFF_V6_DEBUG", DEFAULTS.debug),
  };
}
