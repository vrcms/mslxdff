// traework 模型服务：get_detail_param 动态拉取（10min 缓存）+ 静态 32 个回退。
import { AGENT_HOST, EP_MODELS, FUNCTION, DEFAULT_MODEL } from "./constants.js";
import { soloHeaders } from "./headers.js";
import { joinModelId } from "../model-id.js";

const CTX = 131072;
const CREATED = 1753600000;
const OWNER = "trae-solo";

export const STATIC_MODEL_IDS = [
  "Doubao-Seed-2.1-Pro", "seed-code-pro-0430", "Doubao-Seed-2.1-Turbo", "Doubao-Seed-2.0-Code",
  "DeepSeek-V4-Flash-Official", "browser_use_subagent", "glm-5.2", "glm-5-turbo", "glm-5",
  "DeepSeek-V4-Pro", "DeepSeek-V4-Flash", "kimi-k3", "kimi-k2.7-code", "kimi-k2.6",
  "minimax-m3", "qwen-3.7-plus", "sagitta", "aquila", "custom_model_gemini",
  "custom_model_placeholder", "custom_model_1M_text", "custom_model_1M", "custom_model_kimi",
  "custom_model_claude", "custom_model_gpt-5", "custom_model_no-fc", "custom_model_deepseek_chat",
  "custom_model_deepseek_reasoner", "custom_model_deepseek_v4", "explore_sub_agent_v13",
  "explore_sub_agent_v2", "summary",
];

export function staticModels(id = "traework") {
  return STATIC_MODEL_IDS.map((m) => ({ id: joinModelId(id, m), object: "model", created: CREATED, owned_by: OWNER, context_length: CTX }));
}

export function normalizeModelName(s) {
  return String(s || "").split("_").map((p) => (p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p)).join("-");
}

// 模型映射：空/auto→默认；去 __ 后缀；下划线转横线宽松匹配；未知→400。
export function mapModel(model, knownIds, def = DEFAULT_MODEL) {
  const m = String(model || "").trim();
  if (!m || m === "auto") return { configName: def };
  const base = m.includes("__") ? m.slice(0, m.indexOf("__")) : m;
  const known = new Set(knownIds || []);
  if (known.has(base)) return { configName: base };
  const norm = normalizeModelName(base);
  if (known.has(norm)) return { configName: norm };
  // 大小写不敏感兜底
  const low = new Map([...known].map((k) => [String(k).toLowerCase(), k]));
  if (low.has(base.toLowerCase())) return { configName: low.get(base.toLowerCase()) };
  if (low.has(norm.toLowerCase())) return { configName: low.get(norm.toLowerCase()) };
  const err = new Error(`unknown model ${JSON.stringify(model)}`);
  err.status = 400;
  throw err;
}

export function createModelsService({
  id = "traework",
  baseUrl = AGENT_HOST,
  fetchImpl,
  getKey,
  getAuth,
  clock = Date.now,
} = {}) {
  const CACHE_TTL_MS = 10 * 60 * 1000;
  let cache = null;
  let fetchedAt = 0;
  const resolvedBase = String(baseUrl || AGENT_HOST).trim().replace(/\/+$/, "");

  async function fetchDynamic() {
    const key = getKey ? getKey() : "";
    const auth = getAuth ? getAuth(key) : null;
    const cred = { ...(auth || {}), accessToken: key || auth?.accessToken || "" };
    const res = await fetchImpl(`${resolvedBase}${EP_MODELS}`, {
      method: "POST",
      headers: soloHeaders(cred, false),
      body: JSON.stringify({ function: FUNCTION, config_names: null, need_prompt: false, current_config_info: null, poly_prompt: true, mode_type: null, agent_type: null }),
    });
    if (!res.ok) throw new Error(`models http ${res.status}`);
    const j = await res.json().catch(() => ({}));
    const list = j?.config_info_list;
    if (!Array.isArray(list) || !list.length) throw new Error("models api returned empty list");
    return list.filter((c) => c?.config_name).map((c) => ({ id: c.config_name, name: c?.display_config?.display_name || c.config_name }));
  }

  async function listModels() {
    const now = clock();
    if (cache && now - fetchedAt < CACHE_TTL_MS) return cache;
    try {
      const dyn = await fetchDynamic();
      cache = dyn.map((m) => ({ id: joinModelId(id, m.id), object: "model", created: CREATED, owned_by: OWNER, context_length: CTX, name: m.name }));
      fetchedAt = now;
      return cache;
    } catch {
      cache = staticModels(id);
      fetchedAt = now;
      return cache;
    }
  }

  async function preheat() {
    try { await listModels(); return { ok: true }; }
    catch (err) { return { ok: false, error: String(err?.message || err).slice(0, 120) }; }
  }

  return { listModels, preheat, mapModel: (m, known) => mapModel(m, known), staticModels: () => staticModels(id), normalizeModelName };
}
