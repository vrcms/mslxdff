// zcode 模型目录：内置 Start/Coding Plan 目录 + allowlist 只增不减补齐 + 目录服务（可选按额度 capabilities 过滤）。
import { joinModelId } from "../model-id.js";
import { loadProviderAllowedModels, saveProviderAllowedModels } from "../../state.js";
import { ZCODE_MODEL_CATALOG } from "./const.js";

const CREATED = 1753600000;
const CACHE_TTL_MS = 10 * 60 * 1000;

// 登录后开箱可用：内置目录只增不减并入 allowlist（对齐 cline allowlist-sync 先例，避免显式请求 403）。
export function seedZcodeAllowlist({ ids = ZCODE_MODEL_CATALOG, file } = {}) {
  const opts = file ? { file } : {};
  const cur = loadProviderAllowedModels("zcode", opts);
  const added = ids.filter((m) => !cur.includes(m));
  if (added.length) saveProviderAllowedModels("zcode", [...cur, ...added], opts);
  return { allowed: [...cur, ...added], added };
}

// 对外目录条目（免费池：价格 0.00；id 带 provider 前缀，对齐 joinModelId 契约）。
export function buildZcodeModelList({ id = "zcode", ids = ZCODE_MODEL_CATALOG } = {}) {
  return ids.map((raw) => ({
    id: joinModelId(id, raw),
    object: "model",
    created: CREATED,
    owned_by: "zcode",
    name: raw,
    price: "0.00",
    enable: true,
    free: true,
    mark: "*", // 可用标注：免费额度内，登录后可直接调用
  }));
}

// 目录服务：静态目录 + 可选 probe()（额度 capabilities 的 live id 列表）过滤；10 分钟缓存。
// probe 缺失/失败/为空 → 返回全量目录（宁可多列不可误删）。
export function createModelsService({ id = "zcode", probe, hasAccount = () => true, clock = Date.now } = {}) {
  let cache = null;
  let fetchedAt = 0;

  async function listModels() {
    if (!hasAccount()) return []; // 未登录：空目录（不假装有额度）
    const now = clock();
    if (cache && now - fetchedAt < CACHE_TTL_MS) return cache;
    let ids = ZCODE_MODEL_CATALOG;
    if (typeof probe === "function") {
      try {
        const live = await probe();
        if (Array.isArray(live) && live.length) {
          const low = new Set(live.map((m) => String(m).toLowerCase()));
          const filtered = ZCODE_MODEL_CATALOG.filter((m) => low.has(m.toLowerCase()));
          ids = filtered.length ? filtered : ZCODE_MODEL_CATALOG;
        }
      } catch {}
    }
    cache = buildZcodeModelList({ id, ids });
    fetchedAt = now;
    return cache;
  }

  function clearCache() {
    cache = null;
    fetchedAt = 0;
  }

  return { listModels, clearCache, _cache: () => cache };
}
