import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, unlinkSync, copyFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { toInferenceModels } from "./claude-desktop/slots.js";

/**
 * -setto claude-desktop：把本机网关写成 **Claude Desktop on 3P** 的 profile。
 *
 * 落点与键面（官方 `claude.com/docs/third-party/claude-desktop/configuration` 「How keys are read」）：
 *  - Windows 本地（非托管）：`%LOCALAPPDATA%\Claude-3p\configLibrary\`
 *  - macOS：`~/Library/Application Support/Claude-3p/configLibrary/`
 *  - Linux：`~/.config/Claude-3p/configLibrary/`（`$XDG_CONFIG_HOME` 优先）
 *  目录里 `_meta.json` 记「哪份配置生效」（`appliedId` + `entries[]`），每份配置是平级的 `<uuid>.json`。
 *  in-app 配置窗口（Developer → Configure Third-Party Inference…）写的就是这里，我们代劳。
 *
 * 三条硬红线（照 `src/sync-claude.js` 的既有纪律，不许松）：
 *  1. 只登记**自己那一条** entry（uuid 由端口派生 → 重跑原地更新、不堆条目），用户/窗口建的其它 entry 一字不动；
 *  2. 现有 JSON 解析失败 → 一律拒写（那是用户在 App 里配过的东西，不是我们的草稿）；
 *  3. 文件里有明文 token → `0600`（新建带 mode + 存量补 chmod），半截 tmp 清理失败要把路径如实交出去。
 *
 * 不碰 `claude_desktop_config.json`（App 自己的 prefs），不碰托管策略（HKLM/HKCU\SOFTWARE\Policies\Claude
 * 一旦存在，App 会整体忽略本地 configLibrary —— 那种情况 `-claude-desktop status` 会明说）。
 */

/** configLibrary 目录（三平台 + env 覆盖，覆盖位专为单测隔离 HOME）。 */
export function claudeDesktopConfigDir() {
  const env = process.env.MSLXDFF_CLAUDE_DESKTOP_DIR;
  if (typeof env === "string" && env.trim()) return env.trim();
  const home = os.homedir();
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    return join(local, "Claude-3p", "configLibrary");
  }
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Claude-3p", "configLibrary");
  const xdg = (process.env.XDG_CONFIG_HOME || "").trim() || join(home, ".config");
  return join(xdg, "Claude-3p", "configLibrary");
}

/** 配置条目 id：由端口派生的确定性 UUID 形态（同 cc-switch 的路子，端口不同即不撞车）。 */
export function desktopConfigId(port) {
  const p = String(Math.max(0, Number(port) || 0) % 1000000).padStart(12, "0");
  return `00000000-0000-4000-8000-${p}`;
}

/** 纯函数：profile 对象（App 侧读的键面）。 */
export function buildDesktopProfile({ baseUrl = "", apiKey = "", rows = [], maxEffort } = {}) {
  return {
    inferenceProvider: "gateway",
    inferenceCredentialKind: "static",
    inferenceGatewayAuthScheme: "bearer", // 本仓鉴权只认 Authorization: Bearer（src/routes/helpers.js authorized()）
    inferenceGatewayBaseUrl: String(baseUrl),
    inferenceGatewayApiKey: String(apiKey),
    inferenceModels: toInferenceModels(rows, { maxEffort }),
  };
}

function norm(text) {
  return String(text || "").replace(/\r\n/g, "\n").trim();
}

function parseJsonOrThrow(text, file) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`JSON 解析失败，拒绝覆盖：${file}`);
  }
}

function readJsonOr(file, { allowMissing = false } = {}) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    if (allowMissing) return null;
    throw new Error(`读不到 ${file}`);
  }
  return parseJsonOrThrow(raw, file);
}

/** 一次性备份（已存在不覆盖）：那份是「mslxdff 首次接管前」的原文。 */
function backupOnce(dir, file, backupDir) {
  if (!existsSync(file)) return null;
  const target = join(backupDir, `${desktopBase(file)}.bak`);
  if (existsSync(target)) return null; // 已有更早的备份，不覆盖
  try {
    mkdirSync(backupDir, { recursive: true });
    copyFileSync(file, target);
    return target;
  } catch {
    return null; // 复制失败不阻塞写入，但绝不谎报「已备份」
  }
}
function desktopBase(file) {
  return String(file).split(/[\\/]/).pop().replace(/\.json$/i, "");
}

/** 原子写（tmp → rename，Windows 占用时退回直写；tmp 里带明文 token 必须先擦再删）。 */
function writeFileSecure(file, text) {
  const tmp = `${file}.tmp.${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  let leftover = null;
  const sweep = () => {
    if (!existsSync(tmp)) return;
    try { unlinkSync(tmp); return; } catch { /* 占用，走擦除 */ }
    try { writeFileSync(tmp, "", "utf8"); } catch { /* 擦不动也继续试删 */ }
    try { unlinkSync(tmp); } catch { leftover = tmp; }
  };
  let written = false;
  try {
    try { writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 }); } catch { writeFileSync(tmp, text, "utf8"); }
    try { chmodSync(tmp, 0o600); } catch { /* Windows 无 posix mode */ }
    try {
      renameSync(tmp, file);
      written = true;
    } catch {
      try { writeFileSync(file, text, { encoding: "utf8", mode: 0o600 }); written = true; } catch { /* 交给下面 throw */ }
    }
  } finally {
    sweep();
  }
  if (!written) throw new Error(`无法写入 ${file}（文件可能被其他进程占用）——配置未更新`);
  try { chmodSync(file, 0o600); } catch { /* ignore */ }
  return leftover;
}

/**
 * 写 profile + 登记 `_meta.json`。
 * @param {{port:number, token:string, rows:{slot:string,model:string,label?:string}[], dir?:string, baseUrl?:string, maxEffort?:string}} p
 */
export function syncToClaudeDesktop(p = {}) {
  const dir = p.dir || claudeDesktopConfigDir();
  const token = String(p.token || "");
  if (!token) throw new Error("claude-desktop: token required（先跑 mslxdff -showtoken）");
  const rows = Array.isArray(p.rows) ? p.rows : [];
  if (!rows.length) throw new Error("claude-desktop: rows required（模型槽位为空）");
  const port = Number(p.port) || 8989;
  const baseUrl = p.baseUrl || `http://127.0.0.1:${port}`;
  const id = desktopConfigId(port);
  const configFile = join(dir, `${id}.json`);
  const metaFile = join(dir, "_meta.json");
  const backupDir = join(dirname(dir), "configLibrary.pre-mslxdff");

  const nextProfile = buildDesktopProfile({ baseUrl, apiKey: token, rows, maxEffort: p.maxEffort });
  const nextProfileText = `${JSON.stringify(nextProfile, null, 2)}\n`;
  // 先读后写：任一份现有文件坏了就整体不动（避免「profile 换了、_meta 没登记」的半截状态）
  // 幂等比较一律用**原文 vs 原文**：解析后的对象 stringify 是紧凑形，与盘上缩进形永远不等 → 会把「没变化」误报成「已更新」
  const oldProfileText = existsSync(configFile) ? readFileSync(configFile, "utf8") : null;
  const oldMetaText = existsSync(metaFile) ? readFileSync(metaFile, "utf8") : null;
  const oldProfile = oldProfileText === null ? null : parseJsonOrThrow(oldProfileText, configFile);
  const oldMeta = oldMetaText === null ? null : parseJsonOrThrow(oldMetaText, metaFile);
  const nextMeta = mergeMeta(oldMeta, { id, name: `mslxdff:${port}` });
  const nextMetaText = `${JSON.stringify(nextMeta, null, 2)}\n`;
  const unchanged = oldProfileText !== null && oldMetaText !== null
    && norm(oldProfileText) === norm(nextProfileText) && norm(oldMetaText) === norm(nextMetaText);
  if (unchanged) {
    return { action: "updated", id, dir, configFile, metaFile, backup: null, changed: false, rows: rows.length, profile: nextProfile, meta: nextMeta };
  }
  const b1 = backupOnce(dir, configFile, backupDir);
  const b2 = backupOnce(dir, metaFile, backupDir);
  mkdirSync(dir, { recursive: true });
  const l1 = writeFileSecure(configFile, nextProfileText);
  const l2 = writeFileSecure(metaFile, nextMetaText);
  return {
    action: oldProfile ? "updated" : "inserted",
    id, dir, configFile, metaFile,
    backup: b1 || b2 || null,
    backups: [b1, b2].filter(Boolean),
    changed: true,
    rows: rows.length,
    profile: nextProfile,
    meta: nextMeta,
    tmpLeftover: [l1, l2].filter(Boolean),
  };
}

/** `_meta.json` 合并：只动我们那一条，其它 entry 与 appliedId 语义原样保留。 */
export function mergeMeta(existing, { id, name }) {
  const base = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing } : {};
  const list = Array.isArray(base.entries) ? base.entries.slice() : [];
  const entries = [];
  let replaced = false;
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    if (String(e.id || "") === String(id)) { entries.push({ ...e, name: String(name) }); replaced = true; }
    else entries.push(e);
  }
  if (!replaced) entries.push({ id: String(id), name: String(name) });
  return { ...base, appliedId: String(id), entries };
}

/** 读当前生效配置（体检与 `--official` 用）。不抛错，一切异常如实回结构。 */
export function readClaudeDesktopProfile({ dir } = {}) {
  const d = dir || claudeDesktopConfigDir();
  const metaFile = join(d, "_meta.json");
  const out = { dir: d, exists: existsSync(d), meta: null, appliedId: "", appliedName: "", appliedFile: "", profile: null, entries: [], error: "" };
  if (!out.exists) { out.error = "目录不存在（App 从未进过 3P 模式，或路径不是本机默认）"; return out; }
  let meta;
  try { meta = readJsonOr(metaFile); } catch (e) { out.error = String(e?.message || e); return out; }
  if (!meta || typeof meta !== "object") { out.error = "_meta.json 不是对象"; return out; }
  out.meta = meta;
  out.entries = Array.isArray(meta.entries) ? meta.entries : [];
  out.appliedId = String(meta.appliedId || "");
  const hit = out.entries.find((e) => String(e?.id || "") === out.appliedId) || null;
  out.appliedName = hit ? String(hit.name || "") : "";
  out.appliedFile = join(d, `${out.appliedId}.json`);
  if (!out.appliedId) { out.error = "appliedId 为空（App 里没选任何配置）"; return out; }
  try { out.profile = readJsonOr(out.appliedFile, { allowMissing: true }); } catch (e) { out.error = String(e?.message || e); }
  if (!out.profile) out.error = out.error || `生效配置 ${out.appliedId}.json 读不到`;
  return out;
}

/**
 * `--official`：把 mslxdff 那条登记从 `_meta.json` 摘掉（不删配置、不吞别人的 entry）。
 * 摘后若 `appliedId` 正是我们那条 → 置空，让 App 回到「未选配置」，用户在登录界面自选官方或别的配置。
 */
export function retireClaudeDesktopProfile({ port, dir } = {}) {
  const d = dir || claudeDesktopConfigDir();
  const metaFile = join(d, "_meta.json");
  const id = desktopConfigId(port);
  const rawText = existsSync(metaFile) ? readFileSync(metaFile, "utf8") : null;
  const meta = rawText === null ? null : parseJsonOrThrow(rawText, metaFile);
  if (!meta || !Array.isArray(meta.entries)) return { action: "none", dir: d, removed: false, remaining: 0 };
  const before = meta.entries.length;
  const entries = meta.entries.filter((e) => String(e?.id || "") !== id);
  const appliedId = String(meta.appliedId || "") === id ? "" : String(meta.appliedId || "");
  const next = { ...meta, entries, appliedId };
  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  // 幂等判据一律「原文 vs 原文」：对象 stringify 是紧凑形，与盘上缩进形永远不等 → 会把「没变化」报成「已摘除」
  if (rawText !== null && norm(rawText) === norm(nextText)) {
    return { action: "unchanged", dir: d, removed: false, remaining: entries.length, appliedId };
  }
  backupOnce(d, metaFile, join(dirname(d), "configLibrary.pre-mslxdff"));
  writeFileSecure(metaFile, nextText);
  return { action: "retired", dir: d, removed: before !== entries.length, remaining: entries.length, appliedId, id };
}
