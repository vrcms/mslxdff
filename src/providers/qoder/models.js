// qoder 模型服务（对齐官方 qodercli + 外部参考 magpie qoder 插件/CLIProxyAPI）：
// 原生 COSY 签名拉 /model/list，10min 缓存（按 region 分桶）；
// 只暴露 enable=true 的可调用模型（enable=false 调对话必挂，不展示）。
// context_config（多窗口 200K/400K/1M）与 thinking_config（推理档位）随目录带出，
// 供 payload 选窗口/档位、供能力层展示——旧版只留 max_input_tokens，拿不到多窗口是"不好用"的一环。
import { compatFetch, timeoutSignal } from "../../compat.js";
import { getEndpoints, normalizeRegion } from "./constants.js";
import { buildCosyHeaders, pathSigFrom } from "./session.js";
import { joinModelId } from "../model-id.js";

const CACHE_TTL_MS = 10 * 60 * 1000;
const CREATED = 1753600000;
const OWNER = "qoder";

const positive = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

// context_config → { windows:[...升序], defaultWindow }（Qoder 的 Context 设置：200K/400K/1M）
function parseContextConfig(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const windows = [];
  let defaultWindow;
  for (const raw of Object.values(value)) {
    if (typeof raw !== "object" || raw === null) continue;
    const tc = positive(raw.token_count);
    if (tc === undefined) continue;
    windows.push(tc);
    if (raw.is_default === true) defaultWindow = tc;
  }
  windows.sort((a, b) => a - b);
  return {
    ...(windows.length ? { windows } : {}),
    ...(defaultWindow !== undefined ? { defaultWindow } : {}),
  };
}

// thinking_config → { efforts:[...], defaultEffort, enabled }（推理档位与是否可关思考）
const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
function parseThinkingConfig(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out = {};
  const isDefault = (e) => typeof e === "object" && e !== null && e.is_default === true;
  const enabled = value.enabled && typeof value.enabled === "object" ? value.enabled : null;
  if (enabled) {
    out.thinks = true;
    const raw = typeof enabled.efforts === "object" && enabled.efforts !== null && !Array.isArray(enabled.efforts) ? enabled.efforts : null;
    if (raw) {
      const efforts = Object.keys(raw).filter((k) => k.trim());
      efforts.sort((a, b) => (EFFORT_ORDER.indexOf(a) < 0 ? 99 : EFFORT_ORDER.indexOf(a)) - (EFFORT_ORDER.indexOf(b) < 0 ? 99 : EFFORT_ORDER.indexOf(b)));
      if (efforts.length) out.efforts = efforts;
      for (const [k, v] of Object.entries(raw)) if (isDefault(v)) out.defaultEffort = k;
    }
  }
  if (value.disabled && typeof value.disabled === "object") out.alwaysThinks = false;
  // enabled.is_default 与 disabled.is_default 都为 true/都 false → 上游给的是"默认开还是默认关"
  if (enabled && isDefault(value.disabled)) out.thinkDefault = false;
  else if (enabled && isDefault(enabled)) out.thinkDefault = true;
  return out;
}

export function extractModels(chatList) {
  const out = [];
  for (const m of Array.isArray(chatList) ? chatList : []) {
    if (!m?.key) continue;
    const ctx = parseContextConfig(m.context_config);
    const think = parseThinkingConfig(m.thinking_config);
    out.push({
      id: m.key,
      name: String(m.display_name || m.key),
      enable: Boolean(m.enable),
      isDefault: Boolean(m.is_default),
      isReasoning: Boolean(m.is_reasoning),
      contextLength: Number(m.max_input_tokens) || 0,
      maxOutputTokens: positive(m.max_output_tokens),
      priceFactor: Number(m.price_factor) || 0,
      isVl: m.is_vl === true,
      source: m.source || "system",
      ...ctx,
      ...think,
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
       // 供 payload 选窗口/档位、能力层展示（随目录带出，不进 /v1/models 也无害，额外字段客户端忽略）
       ...(m.windows ? { context_windows: m.windows } : {}),
       ...(m.defaultWindow ? { default_window: m.defaultWindow } : {}),
       ...(m.efforts ? { reasoning_efforts: m.efforts } : {}),
       ...(m.defaultEffort ? { default_reasoning_effort: m.defaultEffort } : {}),
       ...(m.maxOutputTokens ? { max_output_tokens: m.maxOutputTokens } : {}),
     }));
     cacheByRegion.set(normRegion, { list, at: now });
     // 兼容旧单测 _getCache：默认读 global 桶
     cache = normRegion === "global" ? list : cache;
     fetchedAt = normRegion === "global" ? now : fetchedAt;
     return list;
   }
 
  function clearCache() { cache = null; fetchedAt = 0; cacheByRegion.clear(); }
  // 快照语义（评审路2 P0：不吃 TTL）：daemon 稳态里 chat 不再回源，能力标记「过期」也比「丢失」强——
  // is_reasoning 启动预热后持续有效；刷新走 listModels（preheat/CLI/聚合路由），chat 路径恒 0 额外上游调用。
  function peekModels(region = "global") {
    return cacheByRegion.get(normalizeRegion(region))?.list ?? null;
  }
  return { listModels, peekModels, clearCache, _getCache: () => cache ?? cacheByRegion.get("global")?.list ?? null };
 }
