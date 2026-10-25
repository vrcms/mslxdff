// multi-ip-pool · 配置解析：env 优先，缺省值集中一处；纯函数，便于单测。
//
// 定位：第三.种出口源（与 v6pool 换本机源地址、warp-pool 换 WARP 出口同层）。
// 思路参照 aimili-vpngate（VPNGate 免费 OpenVPN 节点当出口），但本模块是：
//   ① Node 实现（不再需要 Python 侧那套进程/代理）；② **N 槽并行**（参照实现一次只挂 1 条隧道）；
//   ③ 只服务 opencode 免费层（免费层按**出口 IP** 计额，见 docs/domain-notes.md §5）。
import { join } from "node:path";
import { logDir } from "../logs.js";

/**
 * 缺省**开** + **只有组长建**（用户 2026-10-25 补裁）：`joined` 里存在"自己当组长"的组才建池。
 * 组员、以及**没带任何组的单机都不建**（这种机器上要用，显式 `MSLXDFF_MULTI_IP_MODE=leader`）。
 * 另三条硬门：只有 Linux（tun + ip rule）、要 root、要有 openvpn 可执行文件。
 */
export const DEFAULTS = {
  enabled: true,
  mode: "auto", // auto | leader | member
  count: 2, // 并行隧道数：每槽一条 openvpn + 一条策略路由表
  country: "", // 国家白名单（ISO 两字母，逗号分隔；空 = 不限）
  minScore: 1_000_000, // VPNGate Score 下限（低于它的节点基本连不动）
  scan: 8, // 起隧道时最多按序尝试多少个候选
  baseTable: 210, // 策略路由表起始号（避开通信/策略常用表）
  devPrefix: "mltun", // tun 设备名前缀（留足内核 15 字符上限）
  probeModel: "", // 「打 hi 探额度」用的免费模型（空 = 与 v6 池对照测试同款）
  strategy: "session", // 会话粘出口：上游按 session 做粘性路由，每请求换出口会撞冷启动
  standby: 5, // 备选出口上限（用户定：**不多于 5**；0 = 关备选池）
  standbyEveryMs: 60 * 60_000, // 备选池刷新周期（每小时重拨一批新 IP）
  connectTimeoutMs: 25_000, // 等 "Initialization Sequence Completed" 的上限
  probeTimeoutMs: 20_000, // 探活/出口取证单发超时
  cooldownMs: 600_000, // 槽失败冷却
  rotate: true, // 撞额度信号时换槽
  nodesTtlMs: 30 * 60_000, // 节点表缓存有效期（VPNGate 免费节点掉得快）
  openvpnBin: "openvpn",
  authUser: "vpn", // VPNGate 公共账号（非私人凭据）
  authPass: "vpn",
  debug: false,
  sysctl: true, // 放宽 rp_filter（严格反向路径过滤会让隧道"活着但请求挂死"）
};

/**
 * VPNGate 节点源：**官方永远在前**，第三方镜像只作兜墙的最后一条。
 * 镜像 `aimili-vpngate` 仓库内 `mirror/vpngate.csv` 由它的 GitHub Actions **每 15 分钟**从官方表刷新
 * （cron `7,22,37,52 * * * *`），实测 2026-10-25 与官方**同 15 列同 schema**、99 节点全部可解码 ⇒ 解析器零改动。
 * 注意：它自己配的那条 GitHub Pages 镜像 `baoweise-bot.github.io/...` 已 404 死（实测），故不采用。
 * 表内容只是**公开节点的连接配置 + VPNGate 公共账号（vpn/vpn）**，不含任何私人凭据；仍不信任镜像就用
 * `MSLXDFF_MULTI_IP_SOURCES` 只留官方，或 `MSLXDFF_MULTI_IP_NODES_FILE` 自带一份本地表。
 */
export const NODE_SOURCES = [
  "https://www.vpngate.net/api/iphone/",
  "http://www.vpngate.net/api/iphone/",
  "https://raw.githubusercontent.com/OpenMili/aimili-vpngate/main/mirror/vpngate.csv",
];

const OFF = ["0", "off", "false", "no", "disable", "disabled"];
const MODES = ["auto", "leader", "member"];

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

function envList(env, name, fallback = "") {
  return String(env[name] ?? fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
/** 备选出口上限：0 = 关；**硬上限 5**（用户 2026-10-25：不多于 5 个备选 IP）。 */
function standbyCount(env) {
  const raw = Number(env.MSLXDFF_MULTI_IP_STANDBY);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULTS.standby;
  return Math.min(5, Math.floor(raw));
}

/** 槽 i 的 tun 设备名（内核上限 15 字符：前缀默认 6 + 序号 ≤2 位，安全）。 */
export function devNameFor(prefix, i) {
  return `${prefix}${i}`;
}

/** 槽 i 的策略路由表号（每槽独立表：`ip rule from <tun 地址> lookup <table>`）。 */
export function tableFor(baseTable, i) {
  return baseTable + i;
}

/**
 * 解析 multi-ip 出口池配置。
 * @param {Record<string, string|undefined>} env
 * @param {{ logDirFn?: () => string }} [deps] 测试可注入 logDir
 */
export function resolveMultiIpConfig(env = process.env, { logDirFn = logDir } = {}) {
  const modeRaw = envStr(env, "MSLXDFF_MULTI_IP_MODE", DEFAULTS.mode).toLowerCase();
  // 受限网络兜墙：`MSLXDFF_MULTI_IP_NODES_FILE` 指的本地表**排在最前**（设了就一次网络都不打）。
  const nodesFile = envStr(env, "MSLXDFF_MULTI_IP_NODES_FILE", "");
  const baseSources = envList(env, "MSLXDFF_MULTI_IP_SOURCES").length
    ? envList(env, "MSLXDFF_MULTI_IP_SOURCES")
    : NODE_SOURCES;
  const sources = nodesFile ? [nodesFile, ...baseSources.filter((s) => s !== nodesFile)] : baseSources;
  return {
    enabled: envBool(env, "MSLXDFF_MULTI_IP_POOL", DEFAULTS.enabled),
    mode: MODES.includes(modeRaw) ? modeRaw : DEFAULTS.mode,
    count: Math.min(8, envInt(env, "MSLXDFF_MULTI_IP_COUNT", DEFAULTS.count)),
    countries: envList(env, "MSLXDFF_MULTI_IP_COUNTRY").map((c) => c.toUpperCase()),
    minScore: envInt(env, "MSLXDFF_MULTI_IP_MIN_SCORE", DEFAULTS.minScore),
    scan: Math.min(32, envInt(env, "MSLXDFF_MULTI_IP_SCAN", DEFAULTS.scan)),
    baseTable: envInt(env, "MSLXDFF_MULTI_IP_BASE_TABLE", DEFAULTS.baseTable),
    devPrefix: envStr(env, "MSLXDFF_MULTI_IP_DEV_PREFIX", DEFAULTS.devPrefix),
    probeModel: envStr(env, "MSLXDFF_MULTI_IP_PROBE_MODEL", DEFAULTS.probeModel),
    strategy: envStr(env, "MSLXDFF_MULTI_IP_STRATEGY", DEFAULTS.strategy) === "request" ? "request" : "session",
    standby: standbyCount(env),
    standbyEveryMs: envInt(env, "MSLXDFF_MULTI_IP_STANDBY_EVERY_MS", DEFAULTS.standbyEveryMs),
    connectTimeoutMs: envInt(env, "MSLXDFF_MULTI_IP_CONNECT_TIMEOUT_MS", DEFAULTS.connectTimeoutMs),
    probeTimeoutMs: envInt(env, "MSLXDFF_MULTI_IP_PROBE_TIMEOUT_MS", DEFAULTS.probeTimeoutMs),
    cooldownMs: envInt(env, "MSLXDFF_MULTI_IP_COOLDOWN_MS", DEFAULTS.cooldownMs),
    rotate: envBool(env, "MSLXDFF_MULTI_IP_ROTATE", DEFAULTS.rotate),
    nodesTtlMs: envInt(env, "MSLXDFF_MULTI_IP_NODES_TTL_MS", DEFAULTS.nodesTtlMs),
    openvpnBin: envStr(env, "MSLXDFF_MULTI_IP_OPENVPN", DEFAULTS.openvpnBin),
    authUser: envStr(env, "MSLXDFF_MULTI_IP_AUTH_USER", DEFAULTS.authUser),
    authPass: envStr(env, "MSLXDFF_MULTI_IP_AUTH_PASS", DEFAULTS.authPass),
    dir: envStr(env, "MSLXDFF_MULTI_IP_DIR", join(logDirFn(), "multi-ip-pool")),
    sources,
    nodesFile,
    debug: envBool(env, "MSLXDFF_MULTI_IP_DEBUG", DEFAULTS.debug),
    sysctl: envBool(env, "MSLXDFF_MULTI_IP_SYSCTL", DEFAULTS.sysctl),
  };
}

/**
 * 角色门（纯函数）：**只有组长建池**（用户 2026-10-25 补裁）；判据与 `-group` 同口径 —— `joined` 里 `leaderUrl` 为空即本节点是组长。
 * 纯组员与"没带任何组的单机"都不建；确需强开设 MSLXDFF_MULTI_IP_MODE=leader。
 * @param {{ mode?: string, joined?: Array<{leaderUrl?: string}> }} opts
 * @returns {{ active: boolean, role: "leader" | "member" | "solo", why: string }}
 */
export function resolveRole({ mode = "auto", joined = [] } = {}) {
  const list = Array.isArray(joined) ? joined : [];
  const leads = list.some((g) => g && !g.leaderUrl);
  const derived = list.length === 0 ? "solo" : leads ? "leader" : "member";
  // 显式覆盖优先于推导（escape hatch：单机/组员机器上 MSLXDFF_MULTI_IP_MODE=leader 强开）
  if (mode === "leader") return { active: true, role: "leader", why: "MSLXDFF_MULTI_IP_MODE=leader（显式强开）" };
  if (mode === "member") return { active: false, role: "member", why: "MSLXDFF_MULTI_IP_MODE=member（显式）" };
  const why = derived === "leader" ? "本节点是组长（自己带的组）" : derived === "solo"
    ? "本节点没带任何组（单机）：按「只有组长启用」不建池，要启用请设 MSLXDFF_MULTI_IP_MODE=leader"
    : "本节点是组员，出口池只由组长建";
  return { active: derived === "leader", role: derived, why };
}