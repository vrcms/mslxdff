import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { loadModelAliases, registerModelAlias, persistModelAliases } from "./providers/model-id.js";

export function workbuddyModelsPath() {
  const env = process.env.WORKBUDDY_MODELS_FILE || process.env.WORKBUDDY_MODELS_PATH;
  if (typeof env === "string" && env.trim()) return env.trim();
  return join(os.homedir(), ".workbuddy", "models.json");
}

// WorkBuddy 不支持模型 ID 中的 /，写入时替换为 -
// mslxdff 需保留原始 / 格式用于路由，所以同时存原始 id
const toWorkbuddyId = (id) => String(id).replace(/\//g, "-");

// 剪枝比较键：legacy 前缀剥掉 + / → -（picks 里 slash 形态与存储 dash 形态互认）
export function normalizeWorkbuddyKey(k) {
  const s = String(k || "");
  const inner = s.startsWith("mslxdff-") ? s.slice("mslxdff-".length) : s;
  return inner.includes("/") ? inner.replace(/\//g, "-") : inner;
}

// 剪枝：只删我们写的本地条目（127.0.0.1）中不在 keep 里的；非本地条目永不动
export function pruneWorkbuddyEntries(arr, keep, currentId) {
  if (!Array.isArray(keep) || !keep.length || !Array.isArray(arr)) return 0;
  const keepSet = new Set([normalizeWorkbuddyKey(currentId), ...keep.map(normalizeWorkbuddyKey)].filter(Boolean));
  let pruned = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    if (!isLocalUrl(m?.url)) continue;
    const keys = [normalizeWorkbuddyKey(m.id), normalizeWorkbuddyKey(m._mslxdffOriginalId)];
    if (!keys.some((k) => k && keepSet.has(k))) { arr.splice(i, 1); pruned++; }
  }
  return pruned;
}

export function buildWorkbuddyEntry({ id, token, port }) {
  const p = Number(port) || 8989;
  const originalId = String(id);
  const wbId = toWorkbuddyId(originalId);
  return {
    id: wbId,
    name: wbId,
    vendor: "Custom",
    url: `http://127.0.0.1:${p}/v1/chat/completions`,
    apiKey: String(token || ""),
    supportsToolCall: true,
    supportsImages: true,
    supportsReasoning: true,
    useCustomProtocol: false,
  };
}

export function isLocalUrl(url) {
  const u = String(url || "");
  return u.includes("127.0.0.1") && u.includes("/v1/chat/completions");
}

function isTargetEntry(m, id) {
  if (!m || typeof m !== "object") return false;
  if (!isLocalUrl(m.url)) return false;
  // 匹配原始 id（/ 格式）和 WorkBuddy id（- 格式）
  if (m.id === id) return true;
  if (m.id === toWorkbuddyId(id)) return true;
  // 兜底：匹配 _mslxdffOriginalId 字段
  if (m._mslxdffOriginalId === id) return true;
  return false;
}

export async function syncToWorkbuddy({ id, token, port, file, keep } = {}) {
  const targetFile = file || workbuddyModelsPath();
  const cleanId = String(id || "").trim();
  if (!cleanId) throw new Error("model id required");
  const cleanToken = String(token || "");
  const p = Number(port) || 8989;

  let arr = [];
  let corrupted = false;
  let rawText = null;
  try {
    rawText = readFileSync(targetFile, "utf8");
    const parsed = JSON.parse(rawText);
    arr = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (rawText !== null) {
      // file existed but unreadable/corrupted -> backup
      corrupted = true;
      try {
        mkdirSync(dirname(targetFile), { recursive: true });
        // only backup if .bak not exists or corrupted content differs?
        writeFileSync(targetFile + ".bak", rawText ?? "", "utf8");
      } catch {}
      arr = [];
    } else {
      // file not exists
      arr = [];
    }
  }

  // find exact target (id + local url, any port -> will update port)
  let idx = arr.findIndex((m) => isTargetEntry(m, cleanId));
  const wbId = toWorkbuddyId(cleanId);
  let action;
  if (idx >= 0) {
    // update token/url/name, preserve other fields
    const old = arr[idx];
    const { _mslxdffOriginalId, ...oldClean } = old;
    arr[idx] = {
      ...oldClean,
      id: wbId,
      name: wbId,
      url: `http://127.0.0.1:${p}/v1/chat/completions`,
      apiKey: cleanToken,
    };
    if (!arr[idx].vendor) arr[idx].vendor = "Custom";
    if (arr[idx].supportsToolCall === undefined) arr[idx].supportsToolCall = true;
    if (arr[idx].supportsImages === undefined) arr[idx].supportsImages = true;
    if (arr[idx].supportsReasoning === undefined) arr[idx].supportsReasoning = true;
    if (arr[idx].useCustomProtocol === undefined) arr[idx].useCustomProtocol = false;
    action = "updated";
  } else {
    // 检查归一化 id 是否与已有条目冲突（如已存在 clinebot-z-ai-glm-5.3-flash 但不是本地 URL）
    const conflict = arr.findIndex((m) => m && m.id === wbId);
    if (conflict >= 0) {
      // 已有同名条目且非我们写的，跳过不覆盖
      return { action: "skipped-conflict", file: targetFile, id: cleanId, conflictId: arr[conflict].id, corrupted: false };
    }
    arr.push(buildWorkbuddyEntry({ id: cleanId, token: cleanToken, port: p }));
    action = "inserted";
  }
  const pruned = pruneWorkbuddyEntries(arr, keep, cleanId);

  // atomic write
  mkdirSync(dirname(targetFile), { recursive: true });
  const tmp = `${targetFile}.tmp.${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  writeFileSync(tmp, JSON.stringify(arr, null, 2), "utf8");
  try {
    // on Windows, rename fails if target exists -> remove first? use renameSync which overwrites on Node 20?
    // try rename, fallback to copy+unlink
    renameSync(tmp, targetFile);
  } catch {
    try { writeFileSync(targetFile, readFileSync(tmp, "utf8"), "utf8"); } catch {}
    try { readFileSync(tmp); } catch {}
    // cleanup tmp
    try { /* remove tmp */ } catch {}
  }
  // cleanup tmp if still exists
  try { if (existsSync(tmp)) { const { unlinkSync } = await import("node:fs"); unlinkSync(tmp); } } catch {}

  // 注册 WorkBuddy 别名：/ → -（仅原始 id 含 / 时）
  if (cleanId.includes("/")) {
    loadModelAliases();
    registerModelAlias(wbId, cleanId);
    persistModelAliases();
  }

  return { action, file: targetFile, id: cleanId, corrupted, pruned };
}
