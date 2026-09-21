// qoder 模型服务（转译 bridge.go ListModels/extractModels）：原生 COSY 签名拉 /model/list，
// 10min 缓存；暴露全部 15 个 key（含 enable=false 的展示，allowlist 由上层过滤）。
import { compatFetch, timeoutSignal } from "../../compat.js";
import { getEndpoints, normalizeRegion } from "./constants.js";
import { buildCosyHeaders, pathSigFrom } from "./session.js";
import { joinModelId } from "../model-id.js";

const CACHE_TTL_MS = 10 * 60 * 1000;
const CREATED = 1753600000;
const OWNER = "qoder";

export function extractModels(chatList) {
  const out = [];
  for (const m of Array.isArray(chatList) ? chatList : []) {
    if (!m?.key) continue;
    out.push({
      id: m.key,
      name: String(m.display_name || m.key),
      enable: Boolean(m.enable),
      isDefault: Boolean(m.is_default),
      isReasoning: Boolean(m.is_reasoning),
      contextLength: Number(m.max_input_tokens) || 0,
      priceFactor: Number(m.price_factor) || 0,
    });
  }
  return out;
}

export function createModelsService({ id = "qoder", fetchImpl, clock = Date.now } = {}) {
  let cache = null, fetchedAt = 0;

  async function listModels(sess, region = "global") {
    const normRegion = normalizeRegion(region);
    const now = clock();
    if (cache && now - fetchedAt < CACHE_TTL_MS) return cache;
    const ep = getEndpoints(normRegion);
    const url = ep.modelListURL;
    const headers = buildCosyHeaders(sess, pathSigFrom(url), "", "application/json");
    const res = await fetchImpl(url, { headers, signal: timeoutSignal(15000) });
    if (!res.ok) throw new Error(`models http ${res.status}`);
    const j = await res.json().catch(() => ({}));
    const models = extractModels(j.chat) || extractModels(j.assistant);
    if (!models.length) throw new Error("models list empty");
    cache = models.map((m) => ({
      id: joinModelId(id, m.id),
      object: "model",
      created: CREATED,
      owned_by: OWNER,
      name: m.name,
      context_length: m.contextLength,
      enable: m.enable,
      is_reasoning: m.isReasoning,
      price_factor: m.priceFactor,
    }));
    fetchedAt = now;
    return cache;
  }

  function clearCache() { cache = null; fetchedAt = 0; }

  return { listModels, clearCache, _getCache: () => cache };
}
