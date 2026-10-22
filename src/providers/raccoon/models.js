// raccoon 模型目录：上游 `model_catalog` 解析 + 兜底目录 + 积分倍率展示名 + allowlist 补齐。
// 倍率是这家供应商的**成本唯一载体**（积分制，不是免费额度），所以它在模型名与列表里都必须出现：
// 0 → 「免费」；1 → 也显示 `x1`（省略会让用户以为「没倍率＝不扣分」）；促销 → `x0.2→x0.1`。
import {
  RACCOON_FALLBACK_MODELS,
  RACCOON_REQUEST_TIMEOUT_MS,
  raccoonModelCatalogUrl,
} from "./const.js";
import { raccoonAuthHeaders } from "./headers.js";
import { parseRaccoonEnvelope } from "./envelope.js";
import { loadProviderAllowedModels, saveProviderAllowedModels } from "../../state/schemas/allowlist.js";
import { joinModelId } from "../model-id.js";

const pickString = (src, keys) => {
  for (const k of keys) {
    const v = src?.[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return "";
};

const pickNumber = (src, keys) => {
  for (const k of keys) {
    const v = src?.[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  }
  return undefined;
};

const pickBool = (src, keys) => {
  for (const k of keys) {
    const v = src?.[k];
    if (typeof v === "boolean") return v;
  }
  return undefined;
};

/** 兜底目录（const.js 的静态表，字段名已归一）。 */
export function raccoonFallbackModels() {
  return RACCOON_FALLBACK_MODELS.map((m) => ({ ...m }));
}

/**
 * 单条目录条目：字段名容错（缺字段即省略，不猜、不填假值）。
 *
 * 上游真实字段（2026-10-22 `GET /api/web/llm/v2/model_catalog` 实测）：
 *   `name`=模型 id（请求体 `model` 用的就是它）、`description`=展示名（如 `DeepSeek-V4.1-Flash`）、
 *   `visible: false`=上游对自己隐藏的内部模型、`params.context_window` / `params.max_tokens`、
 *   `billing_multiplier` / `billing_effective_multiplier`。
 * ⚠ **id 绝不能取 `description`**：旧`pickString(["modelName","name","displayName","description"])`
 * 把 id 与展示名混在一串里，一旦上游条目的 `name` 缺失就会拿展示名当 id 去发请求（必 404/400）。
 */
function parseRaccoonModelEntry(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  // 上游用 visible:false 表示「我这边不展示」，这类内部模型不进目录
  if (raw.visible === false) return null;
  const id = pickString(raw, ["id", "modelId", "model_id", "modelName", "name"]);
  if (!id) return null;
  const model = { id };
  // 展示名单独取，且排除与 id 同值的情况（否则列表会出现「xxx · xxx」）
  const name = pickString(raw, ["description", "displayName", "modelName", "name"]);
  if (name && name !== id) model.name = name;
  const params = raw.params && typeof raw.params === "object" ? raw.params : {};
  const ctx = pickNumber(raw, ["contextWindow", "context_window", "contextLength", "context_length"]) ?? pickNumber(params, ["context_window", "contextWindow"]);
  if (ctx !== undefined && ctx > 0) model.contextWindow = ctx;
  const maxTokens = pickNumber(raw, ["maxTokens", "max_tokens", "maxCompletionTokens"]) ?? pickNumber(params, ["max_tokens", "maxTokens"]);
  if (maxTokens !== undefined && maxTokens > 0) model.maxTokens = maxTokens;
  const img = pickBool(raw, ["supportsImage", "supports_image", "supportsVision"]);
  if (img !== undefined) model.supportsImage = img;
  const eff = pickNumber(raw, ["effectiveMultiplier", "effective_multiplier", "billing_effective_multiplier", "multiplier", "costMultiplier"]);
  if (eff !== undefined && eff >= 0) model.multiplier = eff;
  const base = pickNumber(raw, ["baseMultiplier", "base_multiplier", "billing_multiplier"]);
  if (base !== undefined && base > 0) model.baseMultiplier = base;
  return model;
}

/**
 * 目录信封 → 条目数组。
 *
 * ⚠ **主形状是 `data.categories[]`，只有 `type: "chat"` 那组才是可路由模型**（2026-10-22 上游实测）。
 * 旧实现只认 `data` 为数组 / `data.models` / `data.list` / `data.items` 四种，而真实报文是
 * `{data:{categories:[...]}}` —— 结果每次都解析出 0 条、静默回落静态兜底表，症状是
 * 「上游新上架的模型（如 `sn-deepseek-v4-1-flash-1017`）在网关里永远看不见」。
 * 另外两条判据同样来自实测：`name` 才是模型 id（`description` 是展示名）、`visible: false`
 * 是上游对自己隐藏的内部模型（`raccoon-*`），不该进目录。
 *
 * 四种旧形状继续兼容（上游改版/其他信封时兜底），按顺序取第一个非空的。
 */
export function parseRaccoonCatalog(data) {
  const list = pickCatalogList(data);
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const m = parseRaccoonModelEntry(raw);
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

function pickCatalogList(data) {
  const arr = (v) => (Array.isArray(v) ? v : null);
  // 真实形状：{ data: { categories: [{ type: "chat", models: [...] }] } }
  const root = data && typeof data === "object" && !Array.isArray(data) ? data : null;
  const categories = arr(root?.categories) ?? arr(root?.data?.categories);
  if (categories) {
    const chat = categories.find((c) => c && typeof c === "object" && c.type === "chat");
    const chatModels = arr(chat?.models);
    if (chatModels) return chatModels;
  }
  return arr(data) ?? arr(root?.models) ?? arr(root?.list) ?? arr(root?.items) ?? [];
}

/** 倍率文案：0 → 免费；促销 → `x基→x实`；其余 → `x实`（含 x1）。 */
export function raccoonMultiplierLabel(model) {
  const eff = typeof model?.multiplier === "number" ? model.multiplier : undefined;
  if (eff === undefined) return "";
  if (eff === 0) return "免费";
  const fmt = (v) => String(Number(v.toFixed(4)));
  const base = typeof model?.baseMultiplier === "number" ? model.baseMultiplier : undefined;
  if (base !== undefined && base > eff) return `x${fmt(base)}→x${fmt(eff)}`;
  return `x${fmt(eff)}`;
}

/** 列表/模型卡展示名：`<名字或 id> · <倍率>`（无倍率时省略后缀）。 */
export function raccoonDisplayName(model) {
  const base = model?.name || model?.id || "";
  const label = raccoonMultiplierLabel(model);
  return label ? `${base} · ${label}` : base;
}

/** 拉上游目录；失败/空目录返回 null（调用方回落兜底表）。 */
export async function fetchRaccoonModelCatalog({
  credential,
  fetchImpl = fetch,
  env = process.env,
  timeoutMs = RACCOON_REQUEST_TIMEOUT_MS,
} = {}) {
  if (!credential?.access_token) return null;
  try {
    const res = await fetchImpl(raccoonModelCatalogUrl(), {
      method: "GET",
      headers: raccoonAuthHeaders(credential, { env }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const envelope = parseRaccoonEnvelope(await res.json(), res.status);
    if (envelope.code !== 0) return null;
    const models = parseRaccoonCatalog(envelope.data);
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

/** 上游优先、兜底次之。返回 `{ models, source }`，source ∈ upstream|fallback。 */
export async function listRaccoonModels({ credential, fetchImpl, env } = {}) {
  const upstream = await fetchRaccoonModelCatalog({ credential, fetchImpl, env });
  if (upstream) return { models: upstream, source: "upstream" };
  return { models: raccoonFallbackModels(), source: "fallback" };
}

/** 登录后把兜底目录 id 只增不减并入 allowlist（避免「登录成功却处处 403」）。 */
export function seedRaccoonAllowlist({ ids, file } = {}) {
  const opts = file ? { file } : {};
  const target = ids || RACCOON_FALLBACK_MODELS.map((m) => m.id);
  const cur = loadProviderAllowedModels("raccoon", opts);
  const added = target.filter((m) => !cur.includes(m));
  if (added.length) saveProviderAllowedModels("raccoon", [...cur, ...added], opts);
  return { allowed: [...cur, ...added], added };
}

/**
 * 把**上游目录**的模型 id 只增不减并入 allowlist。
 *
 * 为什么需要：白名单此前只在登录时按**静态兜底表**播种一次，上游后来上架的模型
 * （如 2026-10 的 `sn-deepseek-v4-1-flash-1017`）就永远进不来 —— dispatcher 拿白名单
 * 过滤 `listModels()`，模型看得见列表却选不到、调用直接被挡。上游目录才是这家唯一真相
 * （积分制，模型 id 全由上游定义），故每次成功拉到目录就同步一次。
 *
 * **为什么只增不减**：目录是**按账号**下发的（套餐不同可见模型数不同），某次拉到一份
 * 较短的目录不代表模型下架；双向收敛会在换号/降级套餐时把白名单越缩越小、把能用的模型删掉。
 * 真要下架的模型留着只会 404，代价远小于误删。对齐 cline 的 `planMerge` 保守口径（ADR-0067）。
 */
export function mergeRaccoonCatalogIntoAllowlist(models, { file } = {}) {
  const ids = (Array.isArray(models) ? models : []).map((m) => String(m?.id || "").trim()).filter(Boolean);
  if (!ids.length) return { added: [] };
  const opts = file ? { file } : {};
  const cur = loadProviderAllowedModels("raccoon", opts);
  const added = ids.filter((m) => !cur.includes(m));
  if (added.length) saveProviderAllowedModels("raccoon", [...cur, ...added], opts);
  return { added };
}

/** 对外目录条目（`/v1/models` 与 CLI models 共用形状）。 */
export function buildRaccoonModelList({ id = "raccoon", models } = {}) {
  const list = models || raccoonFallbackModels();
  return list.map((m) => ({
    id: joinModelId(id, m.id),
    object: "model",
    owned_by: "raccoon",
    name: raccoonDisplayName(m),
    context_length: m.contextWindow,
    max_tokens: m.maxTokens,
    supports_image: m.supportsImage,
    multiplier: m.multiplier,
    mark: raccoonMultiplierLabel(m) || undefined,
  }));
}
