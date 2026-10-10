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

/** 单条目录条目：字段名容错（缺字段即省略，不猜、不填假值）。 */
function parseRaccoonModelEntry(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const id = pickString(raw, ["id", "modelId", "model_id", "modelName", "name"]);
  if (!id) return null;
  const model = { id };
  const name = pickString(raw, ["modelName", "name", "displayName", "description"]);
  if (name) model.name = name;
  const ctx = pickNumber(raw, ["contextWindow", "context_window", "contextLength", "context_length"]);
  if (ctx !== undefined && ctx > 0) model.contextWindow = ctx;
  const maxTokens = pickNumber(raw, ["maxTokens", "max_tokens", "maxCompletionTokens"]);
  if (maxTokens !== undefined && maxTokens > 0) model.maxTokens = maxTokens;
  const img = pickBool(raw, ["supportsImage", "supports_image", "supportsVision"]);
  if (img !== undefined) model.supportsImage = img;
  const eff = pickNumber(raw, ["effectiveMultiplier", "effective_multiplier", "multiplier", "costMultiplier"]);
  if (eff !== undefined && eff >= 0) model.multiplier = eff;
  const base = pickNumber(raw, ["baseMultiplier", "base_multiplier"]);
  if (base !== undefined && base > 0) model.baseMultiplier = base;
  return model;
}

/** 目录信封 → 条目数组。兼容 `data` 为数组、`data.models`、`data.list`、`data.items` 四种形状。 */
export function parseRaccoonCatalog(data) {
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.models)
      ? data.models
      : Array.isArray(data?.list)
        ? data.list
        : Array.isArray(data?.items)
          ? data.items
          : [];
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
