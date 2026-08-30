// 模型 ID 前缀解析：`<provider>/<rawId>`。默认供应商（opencode）保持裸 id（向后兼容），
// 其它供应商必须带前缀，请求按前缀路由到对应上游通道。
//
// WorkBuddy 别名系统：
// WorkBuddy 不支持模型 ID 中的 /，写入 models.json 时替换为 -
// mslxdff 在收到请求时通过固定映射表还原为 / 格式
// 映射表持久化在 ~/.config/mslxdff/model-aliases.json

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";

export const DEFAULT_PROVIDER = "opencode";

const ALIASES = { oc: "opencode", opencode: "opencode" };

// WorkBuddy 别名映射（alias → canonical）：clinebot-z-ai-glm-5.3-flash → clinebot/z-ai/glm-5.3-flash
const _modelAliases = new Map();

function aliasFile() {
  const env = process.env.MSLXDFF_ALIASES_FILE;
  if (typeof env === "string" && env.trim()) return env.trim();
  return join(os.homedir(), ".config", "mslxdff", "model-aliases.json");
}

export function loadModelAliases(file) {
  const fp = file || aliasFile();
  try {
    const raw = JSON.parse(readFileSync(fp, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === "string" && v) _modelAliases.set(String(k), v);
      }
      _aliasLoaded = true;
    }
  } catch {}
}

export function registerModelAlias(alias, canonical) {
  const a = String(alias || "").trim();
  const c = String(canonical || "").trim();
  if (!a || !c || a === c) return;
  _modelAliases.set(a, c);
}

export function persistModelAliases(file) {
  const fp = file || aliasFile();
  try {
    mkdirSync(dirname(fp), { recursive: true });
    const obj = Object.fromEntries(_modelAliases);
    writeFileSync(fp, JSON.stringify(obj, null, 2), "utf8");
  } catch {}
}

let _aliasLoaded = false;
export function getModelAlias(id) {
  const key = String(id || "").trim();
  let hit = _modelAliases.get(key);
  if (hit) return hit;
  // 未命中时尝试加载（支持 daemon 运行期间由 -setto 进程写入的新 alias）
  try { loadModelAliases(); } catch {}
  return _modelAliases.get(key) || null;
}

// 反向查询：canonical id → alias（如 clinebot/z-ai/glm-5.3-flash → clinebot-z-ai-glm-5.3-flash）
export function getAliasForModel(canonicalId) {
  const c = String(canonicalId || "").trim();
  if (!_aliasLoaded) { try { loadModelAliases(); } catch {} }
  for (const [alias, target] of _modelAliases) {
    if (target === c) return alias;
  }
  return null;
}

export function normalizeProviderId(p) {
  const id = String(p || "").trim();
  return ALIASES[id] || id;
}

// 把（可能带前缀的）模型 id 拆成 { provider, raw, prefixed }
// - 无前缀（含默认供应商裸 id）→ provider = DEFAULT_PROVIDER
// - 前缀是已知供应商 → 对应路由；开头的 `oc/` 视为 opencode 别名
export function splitModelId(id, knownProviders = []) {
  const s = String(id || "");
  if (!s) return { provider: DEFAULT_PROVIDER, raw: s, prefixed: false };
  const idx = s.indexOf("/");
  if (idx > 0) {
    const head = normalizeProviderId(s.slice(0, idx));
    const known = new Set([DEFAULT_PROVIDER, ...knownProviders]);
    if (known.has(head)) {
      return { provider: head, raw: s.slice(idx + 1), prefixed: true };
    }
  }
  return { provider: DEFAULT_PROVIDER, raw: s, prefixed: false };
}

// 生成对外暴露的模型 id：默认供应商裸 id（向后兼容），其它供应商带前缀
export function joinModelId(provider, raw, { force = false } = {}) {
  provider = normalizeProviderId(provider || "");
  raw = String(raw || "");
  if (provider === DEFAULT_PROVIDER && !force) return raw;
  return `${provider}/${raw}`;
}

// 观测用全称：始终带前缀（opencode 也带），用于 modelStats / calls.log 聚合主键
export function toFullId(provider, raw) {
  provider = normalizeProviderId(provider || "");
  raw = String(raw || "").trim();
  if (!raw) return "";
  if (!provider || provider === DEFAULT_PROVIDER) return `${DEFAULT_PROVIDER}/${raw}`;
  return `${provider}/${raw}`;
}

// 归一任意输入为全称：裸 id -> opencode/xxx，已带前缀保持不变（大小写保留，provider 归一）
// 优先查 WorkBuddy 别名表（固定映射），命中直接还原为 / 格式
export function normalizeFullId(id, knownProviders = []) {
  const s = String(id || "").trim();
  if (!s) return "";
  // 1. 查别名表（clinebot-z-ai-glm-5.3-flash → clinebot/z-ai/glm-5.3-flash）
  const aliased = getModelAlias(s);
  if (aliased) return aliased;
  // 2. 已含 /，走原有逻辑
  const idx = s.indexOf("/");
  if (idx > 0) {
    const head = normalizeProviderId(s.slice(0, idx));
    if (knownProviders.length) {
      const known = new Set([DEFAULT_PROVIDER, ...knownProviders.map(normalizeProviderId)]);
      if (known.has(head)) return `${head}/${s.slice(idx + 1)}`;
      return `${DEFAULT_PROVIDER}/${s}`;
    }
    return `${head}/${s.slice(idx + 1)}`;
  }
  return `${DEFAULT_PROVIDER}/${s}`;
}