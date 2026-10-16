// warp-pool · 配置解析：env 优先，缺省值集中在一处；纯函数，便于单测。
import { join } from "node:path";
import { logDir } from "../logs.js";

/** 缺省开 + 429 时换身份换出口：他项目真机实测「同一身份连发 3 次 429，身份一换同一个请求立刻 200」⇒ 换身份＝换桶。 */
export const DEFAULTS = {
  enabled: true,
  mode: "leader",
  count: 4,
  basePort: 10800,
  strategy: "session",
  cooldownMs: 600_000,
  autodownload: true,
  registerMinGapMs: 6_000,
  registerMaxGapMs: 15_000,
  probePath: "/zen/v1/models",
  rotate: true,
};

const OFF = ["0", "off", "false", "no", "disable", "disabled"];

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
 * 解析 warp-pool 运行时配置。
 * @param {Record<string,string|undefined>} env
 * @param {{ logDirFn?: () => string }} [deps] 测试可注入 logDir
 */
export function resolveWarpConfig(env = process.env, { logDirFn = logDir } = {}) {
  const enabled = envBool(env, "MSLXDFF_WARP_POOL", DEFAULTS.enabled);
  const mode = envStr(env, "MSLXDFF_WARP_MODE", DEFAULTS.mode);
  const count = envInt(env, "MSLXDFF_WARP_COUNT", DEFAULTS.count);
  const basePort = envInt(env, "MSLXDFF_WARP_BASE_PORT", DEFAULTS.basePort);
  const strategy = envStr(env, "MSLXDFF_WARP_STRATEGY", DEFAULTS.strategy) === "request" ? "request" : "session";
  const cooldownMs = envInt(env, "MSLXDFF_WARP_COOLDOWN_MS", DEFAULTS.cooldownMs);
  const dir = envStr(env, "MSLXDFF_WARP_DIR", join(logDirFn(), "warp-pool"));
  const bin = envStr(env, "MSLXDFF_WARP_BIN", "");
  const autodownload = envBool(env, "MSLXDFF_WARP_AUTODOWNLOAD", DEFAULTS.autodownload);
  const probePath = envStr(env, "MSLXDFF_WARP_PROBE_PATH", DEFAULTS.probePath);
  const rotate = envBool(env, "MSLXDFF_WARP_ROTATE", DEFAULTS.rotate);

  return {
    enabled,
    active: enabled && mode === "leader",
    mode,
    count,
    basePort,
    strategy,
    cooldownMs,
    dir,
    bin,
    autodownload,
    probePath,
    rotate,
    registerMinGapMs: DEFAULTS.registerMinGapMs,
    registerMaxGapMs: DEFAULTS.registerMaxGapMs,
    /** 节点端口列表：basePort .. basePort+count-1 */
    ports: Array.from({ length: count }, (_, i) => basePort + i),
  };
}
