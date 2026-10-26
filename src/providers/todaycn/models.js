// todaycn 模型目录：**源 = GET /v1/pricing/status 的 data.status.modelOptions.options[]**
// —— 那是账号「真正可选」的那份（本号实测 = 2 项：model.deepseek-v4.1-flash 1× / model.glm-5.3 4×）。
// /v1/llm/models 的 35 个 id 属「看得见、用不了」的内部目录（PUT /v1/pricing/model-option 一律
// 400 request.validation_failed），故**不挂**；将来若要挂，只作参考不进口径。
//
// 多号：目录取各号 options 的并集（谁有哪个模型谁顶上），每号记自己可选的集合，供 index.js 选路。

import { joinModelId } from "../model-id.js";
import { loadProviderAllowedModels, saveProviderAllowedModels } from "../../state.js";
import { TODAYCN_DEFAULT_OPTION, toGatewayModelId } from "./const.js";

const CACHE_TTL_MS = 10 * 60 * 1000;
const CREATED = 1761400000;

/** 从 pricing/status 响应里取 modelOptions（兼容 data.status 与裸 status 两种信封）。 */
export function parseModelStatus(json) {
  const status = json?.data?.status ?? json?.status ?? json ?? {};
  const mo = status?.modelOptions ?? json?.data?.modelOptions ?? json?.modelOptions ?? null;
  const options = Array.isArray(mo?.options) ? mo.options : [];
  return {
    selectedOptionId: String(mo?.selectedOptionId || status?.modelOptionId || ""),
    options: options
      .map((o) => ({
        optionId: String(o?.id || o?.optionId || ""),
        title: String(o?.display?.title || ""),
        subtitle: String(o?.display?.subtitle || ""),
        disabled: Boolean(o?.disabled),
      }))
      .filter((o) => o.optionId),
  };
}

/** 「消耗倍数：4×」→ "4x"（取不到给空串，界面回落 —）。 */
export function parseMultiplier(subtitle = "") {
  const m = String(subtitle).match(/(\d+(?:\.\d+)?)\s*[×x]/i);
  return m ? `${m[1]}x` : "";
}

/** 对外目录条目（OpenAI /v1/models 形状；照 zcode 的字段集，价格列放消耗倍率）。 */
export function buildTodaycnModelList({ id = "todaycn", options = [] } = {}) {
  return options.map((o) => {
    const raw = toGatewayModelId(o.optionId);
    return {
      id: joinModelId(id, raw),
      object: "model",
      created: CREATED,
      owned_by: "todayai",
      name: o.title || raw,
      price: parseMultiplier(o.subtitle) || "—",
      enable: !o.disabled,
      free: false,
      mark: o.optionId === TODAYCN_DEFAULT_OPTION ? "*" : "",
    };
  });
}

/** 登录后播种 allowlist（只增不减，对齐 cline/zcode 先例，避免显式请求 403）。 */
export function seedTodaycnAllowlist({ ids = [], file } = {}) {
  const opts = file ? { file } : {};
  const cur = loadProviderAllowedModels("todaycn", opts);
  const added = ids.map((m) => toGatewayModelId(m)).filter((m) => m && !cur.includes(m));
  if (added.length) saveProviderAllowedModels("todaycn", [...cur, ...added], opts);
  return { allowed: [...cur, ...added], added };
}

/**
 * 目录服务：options 由 index.js 注入（多号并集 + 缓存由本层做）。
 * loadOptions() → [{ optionId, title, subtitle, disabled }]；失败/为空 → 空目录（不假装有额度）。
 */
export function createModelsService({ id = "todaycn", loadOptions, hasAccount = () => true, clock = Date.now, ttlMs = CACHE_TTL_MS } = {}) {
  let cache = null;
  let fetchedAt = 0;

  async function listModels() {
    if (!hasAccount()) return [];
    const now = clock();
    if (cache && now - fetchedAt < ttlMs) return cache;
    let options = [];
    if (typeof loadOptions === "function") {
      try { options = (await loadOptions()) || []; } catch { options = []; }
    }
    cache = buildTodaycnModelList({ id, options: Array.isArray(options) ? options : [] });
    fetchedAt = now;
    return cache;
  }

  function clearCache() {
    cache = null;
    fetchedAt = 0;
  }

  return { listModels, clearCache, _cache: () => cache };
}