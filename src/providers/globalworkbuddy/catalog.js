// `/v3/config` 产品文档 → 可调用模型表。
// 解析纪律照参考仓库 `parseModelCatalog`（upstream.ts:1100-1153），但**成员判定按国际版实测**：
//   成员 = `agents[name==cli].models` 白名单 ∩ 可用行（`disabled!==true` 且 maxInput/maxOutput 均 > 0）。
// 为什么要「交」而不是直接信白名单：白名单里有、但池里没有元数据的多是别名（`default-model`/`fast-model`/
// `primary-model` 等），直调容易被拒；反过来池里有、白名单没有的是「本身份不能调」的模型。两个都不能进选择器。
// 国际版独有：行的窗口是 `contextWindow` **对象**（`defaultLength` + `supportedLengths[]`），国内版是平铺 `maxInputTokens`。
import { KNOWN_MODELS } from "./constants.js";

/** 目录可能带 `{code,msg,data}` 信封，也可能把产品文档**裸**放在顶层（实测两种都出现过）。 */
export function unwrapConfigDocument(json) {
  if (!json || typeof json !== "object") return {};
  if (json.data && typeof json.data === "object" && !Array.isArray(json.data)) return json.data;
  if (Array.isArray(json.models) || Array.isArray(json.agents)) return json;
  return {};
}

/** `x0.79 credits` / `x0.79` → 0.79；空串（别名行）→ 0；无法解析 → 999（排到最后，不当免费）。 */
export function creditsValue(credits) {
  const s = String(credits ?? "").trim();
  if (!s) return 0;
  const m = s.match(/x\s*([\d.]+)/i);
  if (m) {
    const v = Number(m[1]);
    return Number.isFinite(v) ? v : 999;
  }
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : 999;
}

/** 折掉上游单位词，得到语言中性倍率（上游会拼英文 `credits`，钉死在文案里会串语言）。 */
export function normalizeCredits(credits) {
  const s = String(credits ?? "").trim();
  if (!s || /^credits?$/i.test(s)) return "";
  return s.replace(/\s+credits?$/i, "").trim();
}

/**
 * `modelPromotions[]`（国际版独有）→ 覆盖该模型的生效促销。
 * 只认实测形状：`enabled` + 时间窗 + `displayMode:"replace"`；不认识的形状**整条丢掉**，
 * 因为「渲染一个自己看不懂的折扣」会把用户实际要付的钱报少。
 */
export function parsePromotions(document, modelId) {
  const list = Array.isArray(document?.modelPromotions) ? document.modelPromotions : [];
  const out = [];
  const now = Date.now();
  for (const p of list) {
    if (!p || typeof p !== "object") continue;
    const targets = Array.isArray(p.modelIds) ? p.modelIds : Array.isArray(p.models) ? p.models : [];
    if (p.enabled === false) continue;
    if (targets.length && !targets.some((x) => String(x) === String(modelId))) continue;
    const start = Number(p.validFrom ?? p.startTime ?? 0);
    const end = Number(p.validTo ?? p.endTime ?? 0);
    const windowed = Number.isFinite(start) && Number.isFinite(end) && start > 0 && end > 0;
    if (windowed && (now < start || now > end)) continue; // 过期促销不得继续显示
    const factor = Number(p.factor ?? p.discount ?? p.rate ?? NaN);
    out.push({
      start: windowed ? start : 0,
      end: windowed ? end : 0,
      label: typeof p.label === "string" ? p.label.trim() : typeof p.name === "string" ? p.name.trim() : "",
      factor: Number.isFinite(factor) ? factor : NaN,
    });
  }
  return out;
}

function positiveNum(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * 解析产品文档。返回按 credits 升序的模型行；**cli 白名单缺失时返回空数组**（由调用方决定回落兜底表）。
 * 每行带 `source: "upstream"`，方便 UI 区分「真目录」与「兜底表」。
 */
export function parseModelCatalog(document) {
  const doc = document && typeof document === "object" ? document : {};
  const rawModels = Array.isArray(doc.models) ? doc.models : [];
  const agents = Array.isArray(doc.agents) ? doc.agents : [];
  let cliIds = null;
  for (const agent of agents) {
    if (agent && typeof agent === "object" && agent.name === "cli" && Array.isArray(agent.models)) {
      cliIds = agent.models.filter((x) => typeof x === "string");
      break;
    }
  }
  if (!cliIds || !cliIds.length) return [];

  const byId = new Map();
  for (const m of rawModels) {
    if (!m || typeof m !== "object") continue;
    const id = typeof m.id === "string" ? m.id.trim() : "";
    if (!id || m.disabled === true) continue;
    const input = Number(m.maxInputTokens) || 0;
    const output = Number(m.maxOutputTokens) || 0;
    if (!positiveNum(input) || !positiveNum(output)) continue; // 「上架但不可服务」的 id 绝不进选择器
    const cw = m.contextWindow && typeof m.contextWindow === "object" ? m.contextWindow : null;
    const defaultLen = cw && positiveNum(cw.defaultLength) ? cw.defaultLength : 0;
    const supported = cw && Array.isArray(cw.supportedLengths)
      ? cw.supportedLengths.filter(positiveNum) : [];
    const credits = normalizeCredits(m.credits);
    byId.set(id, {
      id,
      name: typeof m.name === "string" && m.name.trim() ? m.name.trim() : id,
      vendor: typeof m.vendor === "string" ? m.vendor : "",
      credits,
      multiplier: creditsValue(m.credits),
      free: creditsValue(m.credits) === 0,
      maxInputTokens: input,
      maxOutputTokens: output,
      contextWindow: defaultLen || input,
      ...(defaultLen ? { defaultContextWindow: defaultLen } : {}),
      ...(supported.length ? { supportedContextWindows: supported } : {}),
      supportsImages: m.supportsImages === true && m.disabledMultimodal !== true,
      supportsReasoning: m.supportsReasoning === true,
      onlyReasoning: m.onlyReasoning === true,
      promotions: parsePromotions(doc, id),
      source: "upstream",
    });
  }

  const rows = cliIds.map((id) => byId.get(id)).filter(Boolean);
  return rows.sort((a, b) => a.multiplier - b.multiplier || a.id.localeCompare(b.id));
}

/** 兜底表：仅上游取数失败时用，标 `source:"fallback"`，**不编窗口数字**。 */
export function fallbackCatalog() {
  return KNOWN_MODELS.map((m) => ({
    ...m,
    multiplier: creditsValue(m.credits),
    free: creditsValue(m.credits) === 0,
    source: "fallback",
  }));
}

/** 挑最便宜的可调用模型（验收 hi 与「省积分」默认值都用它）。 */
export function pickCheapest(rows) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r.id === "string") : [];
  if (!list.length) return null;
  return [...list].sort((a, b) => (a.multiplier ?? 999) - (b.multiplier ?? 999) || a.id.localeCompare(b.id))[0];
}
