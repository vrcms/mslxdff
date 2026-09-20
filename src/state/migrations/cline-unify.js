/**
 * 幂等状态迁移：把遗留 id 的 cline 配置合并进 `cline` 并删除旧键（供应商 id 统一）。
 * 见 .scratch/cline-unify/SPEC.md §4.5；语义：keys 去重 + 剔除 sk_ 旧式 key、allowlist 求并、baseUrl 收敛为根。
 * 绝不触碰 modelPicks / modelErrors / modelLatencies（旧 clinebot/* 键交给既有 prune --orphans）。
 */
import { chmodSync, copyFileSync, existsSync } from "node:fs";
import { defaultStateFile, readState, writeStateImmediate } from "../store.js";
import { normalizeAllowedModel, normalizeEndpointPath } from "../provider-config.js";
import { appendEvent } from "../../logs.js";

export const CLINE_DEFAULT_BASE_URL = "https://api.cline.bot";
export const LEGACY_CLINE_IDS = ["clinebot", "cline-bot"];

/**
 * cline 的 chat URL = `baseUrl` + `loadProviderChatPath()`；而 loadProviderChatPath 缺省**恒**返回
 * `/chat/completions`（src/providers/cline/index.js 里那个按 `/api/v1` 智能兜底的 defaultChat 是死代码，
 * 永远轮不到它生效）。所以 baseUrl 必须自带 `/api/v1`，否则会拼成 `https://api.cline.bot/chat/completions`
 * → 上游 404（2026-09-20 端到端实测）。只对 cline 官方域补全，自定义/代理 baseUrl 不做猜测。
 */
export function normalizeClineBaseUrl(u) {
  const s = String(u || "").trim().replace(/\/+$/, "");
  if (!s) return `${CLINE_DEFAULT_BASE_URL}/api/v1`;
  if (/\/api\/v1$/i.test(s)) return s;
  if (/^https?:\/\/api\.cline\.bot$/i.test(s)) return `${s}/api/v1`;
  return s;
}

function uniq(list) { return [...new Set(list)]; }
function strList(v) { return Array.isArray(v) ? v.map((x) => String(x || "").trim()).filter(Boolean) : []; }
// sk_ 旧式 API key（D3：cline 只认 refreshToken，数据层剔除）
function isLegacySkKey(k) { return /^sk[-_]/i.test(k); }

/** 合并后的 cline 配置：只重建 cline 自己的字段，不吸收旧 id 的 allowAnyModels（避免意外放宽安全默认） */
function mergeConfig(cl, bot) {
  const next = {
    baseUrl: normalizeClineBaseUrl(cl.baseUrl || bot.baseUrl),
    keys: uniq([...strList(cl.keys), ...strList(bot.keys)]).filter((k) => !isLegacySkKey(k)),
    allowedModels: uniq([...strList(cl.allowedModels), ...strList(bot.allowedModels)]
      .map((m) => normalizeAllowedModel(m, "cline")).filter(Boolean)),
  };
  if (Array.isArray(cl.auths) && cl.auths.length) next.auths = cl.auths;
  if (typeof cl.allowAnyModels === "boolean") next.allowAnyModels = cl.allowAnyModels;
  const modelsPath = normalizeEndpointPath(cl.modelsPath || bot.modelsPath || "");
  if (modelsPath) next.modelsPath = modelsPath;
  const chatPath = normalizeEndpointPath(cl.chatPath || bot.chatPath || "");
  if (chatPath) next.chatPath = chatPath;
  return next;
}

/** 备份到同目录 state.json.bak-<ISO时间戳>，权限收紧 0600（含凭据，绝不外泄） */
function backupState(file, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const target = `${file}.bak-${stamp}`;
  copyFileSync(file, target);
  try { chmodSync(target, 0o600); } catch {}
  return target;
}

/**
 * @param {{file?:string, dryRun?:boolean, backup?:boolean}} opts
 * @returns {{applied:boolean, changed:boolean, reason?:string, before?:object, after?:object, backup?:string}}
 *   `applied` 仅在真正落盘时为 true；before/after 只含计数，绝不含凭据明文。
 */
export function clineUnifyMigration({ file = defaultStateFile(), dryRun = false, backup = true } = {}) {
  const configs = readState(file).providerConfigs || {};
  const legacyId = LEGACY_CLINE_IDS.find((pid) => configs[pid] && typeof configs[pid] === "object");
  if (!legacyId) return { applied: false, changed: false, reason: "no legacy cline id" };
  const bot = configs[legacyId];
  const cl = configs.cline && typeof configs.cline === "object" ? configs.cline : {};
  const next = mergeConfig(cl, bot);
  const before = {
    keys: strList(cl.keys).length + strList(bot.keys).length,
    allowedModels: uniq([...strList(cl.allowedModels), ...strList(bot.allowedModels)]).length,
  };
  const after = { keys: next.keys.length, allowedModels: next.allowedModels.length };
  if (dryRun) return { applied: false, changed: true, reason: "dry-run", before, after };
  let backupPath = null;
  if (backup) {
    try { if (existsSync(file)) backupPath = backupState(file); } catch {}
  }
  const merged = { ...configs, cline: next };
  for (const pid of LEGACY_CLINE_IDS) delete merged[pid];
  writeStateImmediate(file, { providerConfigs: merged });
  try {
    appendEvent({
      type: "cline-unify-migrated",
      from: legacyId,
      keys: after.keys,
      allowedModels: after.allowedModels,
      backup: backupPath ? backupPath.replace(/\\/g, "/").split("/").pop() : null,
    });
  } catch {}
  return { applied: true, changed: true, reason: `merged ${legacyId}`, before, after, ...(backupPath ? { backup: backupPath } : {}) };
}
