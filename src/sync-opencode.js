import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";

export function opencodeConfigPath() {
  const env = process.env.OPENCODE_CONFIG || process.env.OPENCODE_CONFIG_PATH;
  if (typeof env === "string" && env.trim()) return env.trim();
  return join(os.homedir(), ".config", "opencode", "opencode.json");
}

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

export function buildOpencodeProvider({ id, token, port }) {
  const p = Number(port) || 8989;
  const alias = toExternalAlias(id);
  return {
    name: "mslxdff",
    npm: "@ai-sdk/openai-compatible",
    options: {
      apiKey: String(token || ""),
      baseURL: `http://127.0.0.1:${p}/v1`,
    },
    models: {
      [alias]: { name: alias },
    },
  };
}

export function isOpencodeLocalUrl(url) {
  const u = String(url || "");
  return u.includes("127.0.0.1") && u.includes("/v1");
}

export async function syncToOpencode({ id, token, port, file } = {}) {
  const targetFile = file || opencodeConfigPath();
  // id 可能是 alias 或原名，统一以 internal 去重、以 external 入库（原名兼容）
  const normalizedRaw = String(id || "").trim();
  if (!normalizedRaw) throw new Error("model id required");
  const internal = toInternalId(normalizedRaw);
  if (!internal) throw new Error("model id required");
  const external = toExternalAlias(internal);
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
  let effectiveId = external;
  if (oldProvider) {
    const oldModels = oldProvider.models && typeof oldProvider.models === "object" && !Array.isArray(oldProvider.models)
      ? oldProvider.models
      : {};
    // 去重：internal 或 external 任一已存在即视为已存在（原名兼容，以 internal 为基准）
    const hasExternal = Object.prototype.hasOwnProperty.call(oldModels, external);
    const hasInternal = Object.prototype.hasOwnProperty.call(oldModels, internal);
    const exists = hasExternal || hasInternal;
    const nextModels = { ...oldModels };
    if (exists) {
      if (hasExternal) {
        nextModels[external] = { name: external, ...(oldModels[external] && typeof oldModels[external] === "object" ? oldModels[external] : {}), name: external };
        effectiveId = external;
      } else if (hasInternal) {
        // 仅原名存在：保留原名不强制迁移为 alias，视为 updated（原名兼容）
        nextModels[internal] = { name: internal, ...(oldModels[internal] && typeof oldModels[internal] === "object" ? oldModels[internal] : {}), name: internal };
        effectiveId = internal;
      }
      action = "updated";
    } else {
      nextModels[external] = { name: external };
      effectiveId = external;
      action = "inserted";
    }
    // 合并 provider：保留 name/npm，覆盖 options.baseURL/apiKey，合并 models
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
    // 若插入的是 alias 但原名已存在，上面已处理为不新增；否则正常
    data.provider.mslxdff = nextProvider;
    // 若是新插入且 external 不等于 internal，且 internal 已存在时，需避免双键，上面已处理
    // 若是新插入 external 且 internal 不存在，正常插入
    if (!exists) {
      data.provider.mslxdff.models = nextModels;
    }
  } else {
    data.provider.mslxdff = buildOpencodeProvider({ id: external, token: cleanToken, port: p });
    action = "inserted";
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

  return { action, file: targetFile, id: effectiveId, alias: external, internal, corrupted };
}
