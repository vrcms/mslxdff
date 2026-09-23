 // qoder 模型服务（转译 bridge.go ListModels/extractModels）：原生 COSY 签名拉 /model/list，
 // 10min 缓存（按 region 分桶）；只暴露 enable=true 的可用模型（enable=false 调对话必挂，不展示）。
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

   // 按 region 分桶缓存：同一进程可能有 cn + global 双号，混用单桶会串区（cn 14 个/global 15 个各不同）。
   const cacheByRegion = new Map();
   async function listModels(sess, region = "global") {
     const normRegion = normalizeRegion(region);
     const now = clock();
     const hit = cacheByRegion.get(normRegion);
     if (hit && now - hit.at < CACHE_TTL_MS) return hit.list;
     const ep = getEndpoints(normRegion);
     const url = ep.modelListURL;
     const headers = buildCosyHeaders(sess, pathSigFrom(url), "", "application/json");
     const res = await fetchImpl(url, { headers, signal: timeoutSignal(15000) });
     if (!res.ok) throw new Error(`models http ${res.status}`);
     const j = await res.json().catch(() => ({}));
     // extractModels 恒返回数组（空数组亦 truthy），必须按长度选 chat/assistant 分支
     const chatModels = extractModels(j.chat);
     const models = chatModels.length ? chatModels : extractModels(j.assistant);
     if (!models.length) throw new Error("models list empty");
     // 只留可用：enable=false 的 key（如 global 的 auto/ultimate，cn 的绝大多数）展示即误导
     const usable = models.filter((m) => m.enable);
     if (!usable.length) throw new Error("models list empty (no enabled models)");
     const list = usable.map((m) => ({
       id: joinModelId(id, m.id),
       object: "model",
       created: CREATED,
       owned_by: OWNER,
       name: m.name,
       context_length: m.contextLength,
       enable: true,
       is_reasoning: m.isReasoning,
       price_factor: m.priceFactor,
     }));
     cacheByRegion.set(normRegion, { list, at: now });
     // 兼容旧单测 _getCache：默认读 global 桶
     cache = normRegion === "global" ? list : cache;
     fetchedAt = normRegion === "global" ? now : fetchedAt;
     return list;
   }
 
   function clearCache() { cache = null; fetchedAt = 0; cacheByRegion.clear(); }
 
   return { listModels, clearCache, _getCache: () => cache ?? cacheByRegion.get("global")?.list ?? null };
 }
