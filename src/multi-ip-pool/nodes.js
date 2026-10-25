// multi-ip-pool · VPNGate 节点表（**纯解析与落盘**侧）：解 CSV → 解 base64 配置 → 筛候选 → 落 conf/缓存。
//
// 为什么要拆开：出口 IP 的**来源**就是这些免费志愿者节点（参照实现 aimili-vpngate 用同一份 CSV），
// 但「取表」在受限网络里是独立的成败关口，它的诊断逻辑单独住在 ./nodes-fetch.js（fetch/归因/出口取证）。
// 纪律：候选的 conf / auth 一律 0600 落在**非工作树**目录（默认 logDir()/multi-ip-pool）。
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** CSV 列序（VPNGate `/api/iphone/`）：末列是 base64 配置，其余为节点元数据。 */
export const VPNGATE_FIELDS = [
  "hostName", "ip", "score", "ping", "speed", "countryLong", "countryShort",
  "sessions", "uptime", "totalUsers", "totalTraffic", "logType", "operator", "message", "config",
];

const CACHE_FILE = "nodes.json";

/** 0755 目录 + 0600 文件：conf 里有 VPNGate 的公证书与账号行，不该给同机其它用户读。 */
function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writePrivate(file, text) {
  writeFileSync(file, text, { mode: 0o600 });
  // mode 只在新建时生效：存量文件补 chmod（照 AGENTS.md 的凭据落地纪律）
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows / 不支持 chmod 的文件系统：忽略 */
  }
  return file;
}

/**
 * 解析 VPNGate CSV。只认「首列是 hostName 的数据行」：
 * 以 `*` 开头的是注释行、以 `#` 开头的是表头。
 * Message 列理论上可能含逗号 ⇒ **末列永远是 config**（base64 不含逗号），中间多余的列并回 message。
 */
export function parseVpnGateCsv(text) {
  const rows = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("*") || line.startsWith("#")) continue;
    const parts = line.split(",");
    if (parts.length < VPNGATE_FIELDS.length) continue;
    const n = parts.length;
    const row = {
      hostName: parts[0],
      ip: parts[1],
      score: Number(parts[2]) || 0,
      ping: Number(parts[3]) || 0,
      speed: Number(parts[4]) || 0,
      countryLong: parts[5],
      countryShort: parts[6],
      sessions: Number(parts[7]) || 0,
      uptime: Number(parts[8]) || 0,
      totalUsers: Number(parts[9]) || 0,
      totalTraffic: Number(parts[10]) || 0,
      logType: parts[11],
      operator: parts[12],
      message: parts.slice(13, n - 1).join(","),
      config: parts[n - 1],
    };
    if (!row.hostName || !row.config) continue;
    rows.push(row);
  }
  return rows;
}

/** base64 → OpenVPN 配置文本；不是一份能用的 client 配置就返回空串（绝不猜）。 */
export function decodeConfig(b64) {
  let text = "";
  try {
    text = Buffer.from(String(b64 || ""), "base64").toString("utf8");
  } catch {
    return "";
  }
  if (!/\bclient\b/.test(text) || !/^\s*remote\s+\S+/m.test(text)) return "";
  return text;
}

/** 从配置文本里读出 `remote <host> <port>`（缺端口按 OpenVPN 默认 1194）。 */
export function parseRemote(conf) {
  const m = /^\s*remote\s+(\S+)(?:\s+(\d+))?/m.exec(String(conf || ""));
  if (!m) return null;
  return { host: m[1], port: m[2] ? Number(m[2]) : 1194 };
}

/** 国家白名单判据：空 = 不限；否则比对 ISO 两字母或全称（大小写无关）。 */
export function matchCountry(row, countries = []) {
  if (!countries.length) return true;
  const short = String(row?.countryShort || "").toUpperCase();
  const long = String(row?.countryLong || "").toUpperCase();
  return countries.some((c) => c === short || c === long);
}

/**
 * 候选队列：按 Score 降序（Score 是 VPNGate 官方"还活着且跑得动"的综合分）。
 * @param {{ rows?: object[], countries?: string[], minScore?: number, scan?: number, skip?: Set<string> }} opts
 */
export function candidateNodes({ rows = [], countries = [], minScore = 0, scan = 8, skip = new Set() } = {}) {
  return rows
    .filter((r) => r.config && r.score >= minScore && matchCountry(r, countries) && !skip.has(r.hostName))
    .sort((a, b) => b.score - a.score || a.ping - b.ping)
    .slice(0, scan);
}

/** 节点表缓存（TTL 内直接用，省一次外网请求；VPNGate 免费节点掉得快，默认 30min）。 */
export function loadNodeCache({ dir, ttlMs = 0, now = () => Date.now() } = {}) {
  try {
    const raw = JSON.parse(readFileSync(join(dir, CACHE_FILE), "utf8"));
    if (!Array.isArray(raw?.rows) || !raw.rows.length) return null;
    if (ttlMs > 0 && now() - Number(raw.fetchedAt || 0) > ttlMs) return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveNodeCache({ dir, source = "", rows = [], now = () => Date.now() } = {}) {
  ensureDir(dir);
  const payload = { fetchedAt: now(), source, rows };
  writePrivate(join(dir, CACHE_FILE), JSON.stringify(payload));
  return payload;
}


/** 落一份 node conf（设备名/路由由 CLI 覆盖，不改原配置文本）；返回文件路径。 */
export function writeNodeConf({ dir, row, name = "" } = {}) {
  ensureDir(dir);
  const safe = String(row.hostName || "node").replace(/[^\w.-]/g, "_").slice(0, 48);
  const alias = name || `${safe}-${row.ip}`;
  return { path: writePrivate(join(dir, `node-${alias}.conf`), row.config), hostName: row.hostName };
}

/** writeNodeConf 落的是**解码后**的配置；这里显式解码一次，把「解不开」的节点挡在门外（绝不猜）。 */
export function materializeNode({ dir, row, name = "" } = {}) {
  const conf = decodeConfig(row.config);
  if (!conf) return null;
  const remote = parseRemote(conf);
  if (!remote) return null;
  const written = writeNodeConf({ dir, row: { ...row, config: conf }, name });
  return { ...row, conf: written.path, host: remote.host, port: remote.port };
}

/** VPNGate 公共账号（vpn/vpn）；落在 0600 文件里，绝不入库。 */
export function writeAuthFile({ dir, user = "vpn", pass = "vpn" } = {}) {
  ensureDir(dir);
  return writePrivate(join(dir, "auth.txt"), `${user}\n${pass}\n`);
}
