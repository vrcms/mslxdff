import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { enrichOpencodeEntry, capsSummary as capsSummaryText } from "./model-capabilities/enrich.js";

export function opencodeConfigPath() {
  const env = process.env.OPENCODE_CONFIG || process.env.OPENCODE_CONFIG_PATH;
  if (typeof env === "string" && env.trim()) return env.trim();
  return join(os.homedir(), ".config", "opencode", "opencode.json");
}

//  legacy mslxdff- 前缀（保留做兼容剥离，新写入不再使用）
export function toExternalAlias(id) {
  const s = String(id || "").trim();
  if (!s) return "";
  return s.startsWith("mslxdff-") ? s : `mslxdff-${s}`;
}

export function toInternalId(aliasOrRaw) {
  const s = String(aliasOrRaw || "").trim();
  if (!s) return "";
  return s.startsWith("mslxdff-") ? s.slice("mslxdff-".length) : s;
}

// 新存储键：/ → -（与 WorkBuddy 一致），裸 id 原样
export function toStorageKey(canonical) {
  const s = String(canonical || "").trim();
  if (!s) return "";
  // 先剥 legacy 前缀
  const internal = toInternalId(s);
  return internal.includes("/") ? internal.replace(/\//g, "-") : internal;
}

// 剪枝比较键：legacy 前缀剥掉 + / → -（picks 里 slash 形态与存储 dash 形态互认）
export function normalizeOpencodeKey(k) {
  const inner = toInternalId(String(k || ""));
  return inner.includes("/") ? inner.replace(/\//g, "-") : inner;
}

// 从存储键还原为内部 canonical（需查 alias 表，调用方用 getModelAlias）
export function storageKeyToCanonical(storageKey) {
  const s = String(storageKey || "").trim();
  if (!s) return "";
  const internal = toInternalId(s);
  return internal;
}

export function buildOpencodeProvider({ id, token, port }) {
  const p = Number(port) || 8989;
  const internal = toInternalId(String(id || "").trim());
  const storageKey = internal.includes("/") ? internal.replace(/\//g, "-") : internal;
  const key = storageKey || toExternalAlias(id); // fallback 兼容
  return {
    name: "mslxdff",
    npm: "@ai-sdk/openai-compatible",
    options: {
      apiKey: String(token || ""),
      baseURL: `http://127.0.0.1:${p}/v1`,
    },
    models: {
      [key]: { name: key },
    },
  };
}

export function isOpencodeLocalUrl(url) {
  const u = String(url || "");
  return u.includes("127.0.0.1") && u.includes("/v1");
}

// 剪枝：删掉不在 keep（picks 口径）里的旧模型键。keep 为空/非数组时不动（向后兼容）。
export function pruneOpencodeModels(models, keep, currentKey) {
  if (!Array.isArray(keep) || !keep.length || !models || typeof models !== "object") return 0;
  const keepSet = new Set([normalizeOpencodeKey(currentKey), ...keep.map(normalizeOpencodeKey)].filter(Boolean));
  let pruned = 0;
  for (const k of Object.keys(models)) {
    if (!keepSet.has(normalizeOpencodeKey(k))) { delete models[k]; pruned++; }
  }
  return pruned;
}

// 补齐：把 ensureAll（picks 口径）里缺失的键写入 models（slash → dash + alias 注册）。
// 已存在但为旧格式（缺 limit 能力字段）的条目也自动补注能力（upgraded 计数）。
// 返回 { nextModels, backfilled, upgraded }；ensureAll 非数组或为空时原样返回。
// 注意：需在剪枝之前调用——先补 picks 缺失，再剪 picks 外旧键，结果集恰为 picks ∪ currentKey。
// capsSvc 透传给能力注入（undefined=全局单例；补齐的条目同样带能力）。
export async function ensureAllOpencodeModels(models, ensureAll, capsSvc) {
  if (!Array.isArray(ensureAll) || !ensureAll.length || !models || typeof models !== "object") {
    return { nextModels: models, backfilled: 0, upgraded: 0 };
  }
  const existing = new Set(Object.keys(models).map(normalizeOpencodeKey));
  let backfilled = 0;
  let upgraded = 0;
  let aliasDirty = false;
  for (const raw of ensureAll) {
    const internal = toInternalId(String(raw || "").trim());
    if (!internal || internal === "auto") continue;
    const storageKey = internal.includes("/") ? internal.replace(/\//g, "-") : internal;
    if (!storageKey) continue;
    if (existing.has(storageKey)) {
      // 已存在：旧格式条目（仅 name、无能力字段）自动升级注入；已带 limit 的新格式不动
      const cur = models[storageKey];
      if (cur && typeof cur === "object" && !Array.isArray(cur) && cur.limit === undefined) {
        const en = await enrichOpencodeEntry(cur, internal, capsSvc);
        models[storageKey] = en.entry;
        if (en.caps) upgraded++;
      }
      continue;
    }
    const enriched = await enrichOpencodeEntry({ name: storageKey }, internal, capsSvc);
    models[storageKey] = enriched.entry;
    existing.add(storageKey);
    backfilled++;
    if (internal.includes("/") && storageKey !== internal) {
      try {
        const { loadModelAliases, registerModelAlias } = await import("./providers/model-id.js");
        loadModelAliases();
        registerModelAlias(storageKey, internal);
        aliasDirty = true;
      } catch {}
    }
  }
  if (aliasDirty) {
    try {
      const { persistModelAliases } = await import("./providers/model-id.js");
      persistModelAliases();
    } catch {}
  }
  return { nextModels: models, backfilled, upgraded };
}

export async function syncToOpencode({ id, token, port, file, keep, ensureAll, capabilities } = {}) {
  const targetFile = file || opencodeConfigPath();
  const normalizedRaw = String(id || "").trim();
  if (!normalizedRaw) throw new Error("model id required");
  const internal = toInternalId(normalizedRaw);
  if (!internal) throw new Error("model id required");
  const storageKey = internal.includes("/") ? internal.replace(/\//g, "-") : internal;
  const cleanToken = String(token || "");
  const p = Number(port) || 8989;

  let data = null;
  let corrupted = false;
  let rawText = null;
  try {
    rawText = readFileSync(targetFile, "utf8");
    const parsed = JSON.parse(rawText);
    data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if (rawText !== null) {
      corrupted = true;
      try {
        mkdirSync(dirname(targetFile), { recursive: true });
        writeFileSync(targetFile + ".bak", rawText ?? "", "utf8");
      } catch {}
      data = {};
    } else {
      data = {};
    }
  }

  if (!data.provider || typeof data.provider !== "object" || Array.isArray(data.provider)) {
    data.provider = {};
  }

  const oldProvider = data.provider.mslxdff && typeof data.provider.mslxdff === "object" && !Array.isArray(data.provider.mslxdff)
    ? data.provider.mslxdff
    : null;

  let action;
  let effectiveId = storageKey;
  let pruned = 0;
  let backfilled = 0;
  let upgraded = 0;
  let currentCaps = null;
  if (oldProvider) {
    const oldModels = oldProvider.models && typeof oldProvider.models === "object" && !Array.isArray(oldProvider.models)
      ? oldProvider.models
      : {};
    // 归一所有旧 key 到 storageKey 维度，判断是否已存在（兼容 mslxdff- 前缀与 / 形态）
    const normalizeToStorage = normalizeOpencodeKey;
    let existingKey = null;
    for (const k of Object.keys(oldModels)) {
      if (normalizeToStorage(k) === storageKey) { existingKey = k; break; }
    }
    // 也兼容直接 internal（slash）形态
    if (!existingKey && Object.prototype.hasOwnProperty.call(oldModels, internal)) existingKey = internal;
    if (!existingKey && Object.prototype.hasOwnProperty.call(oldModels, storageKey)) existingKey = storageKey;

    const nextModels = { ...oldModels };
    if (existingKey) {
      // 已存在：迁移到 storageKey（新规范），清理旧的 legacy 键
      const oldEntry = oldModels[existingKey];
      const merged = oldEntry && typeof oldEntry === "object" && !Array.isArray(oldEntry) ? oldEntry : {};
      // 若 existingKey !== storageKey，需要把旧键删掉，统一到 storageKey
      if (existingKey !== storageKey) {
        // 收集所有同逻辑的旧键一起清理
        for (const k of Object.keys(oldModels)) {
          if (normalizeToStorage(k) === storageKey) delete nextModels[k];
        }
        // 也清理 legacy mslxdff- 前缀变体
        const legacyAlias = toExternalAlias(storageKey);
        const legacyInternal = toExternalAlias(internal);
        if (nextModels[legacyAlias]) delete nextModels[legacyAlias];
        if (legacyInternal !== legacyAlias && nextModels[legacyInternal]) delete nextModels[legacyInternal];
      }
      const enriched = await enrichOpencodeEntry({ ...merged, name: storageKey }, internal, capabilities);
      nextModels[storageKey] = enriched.entry;
      currentCaps = enriched.caps;
      effectiveId = storageKey;
      action = "updated";
    } else {
      const enriched = await enrichOpencodeEntry({ name: storageKey }, internal, capabilities);
      nextModels[storageKey] = enriched.entry;
      currentCaps = enriched.caps;
      effectiveId = storageKey;
      action = "inserted";
    }
    const ensured = await ensureAllOpencodeModels(nextModels, ensureAll, capabilities);
    backfilled = ensured.backfilled;
    upgraded = ensured.upgraded || 0;
    pruned = pruneOpencodeModels(nextModels, keep, storageKey);
    const nextProvider = {
      ...oldProvider,
      name: oldProvider.name || "mslxdff",
      npm: oldProvider.npm || "@ai-sdk/openai-compatible",
      options: {
        ...(oldProvider.options && typeof oldProvider.options === "object" ? oldProvider.options : {}),
        baseURL: `http://127.0.0.1:${p}/v1`,
        apiKey: cleanToken,
      },
      models: nextModels,
    };
    data.provider.mslxdff = nextProvider;
  } else {
    data.provider.mslxdff = buildOpencodeProvider({ id: storageKey, token: cleanToken, port: p });
    // buildOpencodeProvider 已用 storageKey，这里再确保
    if (!data.provider.mslxdff.models[storageKey]) {
      data.provider.mslxdff.models = { [storageKey]: { name: storageKey } };
    }
    const enrichedNew = await enrichOpencodeEntry(data.provider.mslxdff.models[storageKey], internal, capabilities);
    data.provider.mslxdff.models[storageKey] = enrichedNew.entry;
    currentCaps = enrichedNew.caps;
    const ensured = await ensureAllOpencodeModels(data.provider.mslxdff.models, ensureAll, capabilities);
    backfilled = ensured.backfilled;
    upgraded = ensured.upgraded || 0;
    action = "inserted";
  }

  // 若内部含 /，注册 dash→slash 别名，供网关 mslxdff 侧自动映射（与 WorkBuddy 同表）
  if (internal.includes("/") && storageKey !== internal) {
    try {
      const { loadModelAliases, registerModelAlias, persistModelAliases } = await import("./providers/model-id.js");
      loadModelAliases();
      registerModelAlias(storageKey, internal);
      persistModelAliases();
    } catch {}
  }

  // 原子写
  mkdirSync(dirname(targetFile), { recursive: true });
  const tmp = `${targetFile}.tmp.${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  try {
    renameSync(tmp, targetFile);
  } catch {
    try {
      writeFileSync(targetFile, readFileSync(tmp, "utf8"), "utf8");
    } catch {}
  }
  try {
    if (existsSync(tmp)) {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(tmp);
    }
  } catch {}

  return { action, file: targetFile, id: effectiveId, alias: storageKey, internal, corrupted, storageKey, pruned, backfilled, upgraded, caps: currentCaps, capsSummaryText: capsSummaryText(currentCaps) };
}
