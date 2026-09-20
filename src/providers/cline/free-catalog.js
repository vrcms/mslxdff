/**
 * Cline 免费目录深模块：只认上游 `free` 数组（公开接口，无需鉴权、无凭据）。
 * GET {bareHost}/api/v1/ai/cline/recommended-models → { recommended, free, clinePass, clineCloud }
 * 供 cline/models.js（聚合目录 + 启动自检）与 `-provider cline free` CLI 共用；缓存由调用方持有。
 */
import { compatFetch } from "../../compat.js";
import { joinUrl } from "../base.js";

export const FREE_CATALOG_PATH = "/api/v1/ai/cline/recommended-models";
export const DEFAULT_CLINE_BASE = "https://api.cline.bot";

// 上游不可达时的内置兜底（2026-09-20 实测 5 个；只有 id 与短名，无凭据）
export const FALLBACK_FREE = Object.freeze([
  { id: "cline-free/deepseek-v4.1-flash", name: "deepseek-v4.1-flash" },
  { id: "cline-free/muse-spark-1.3-contributor", name: "muse-spark-1.3-contributor" },
  { id: "z-ai/glm-5.3-flash", name: "glm-5.3-flash" },
  { id: "cline-free/solar-pro4", name: "solar-pro4" },
  { id: "poolside/laguna-s-2.1:free", name: "laguna-s-2.1:free" },
]);
export const FALLBACK_FREE_IDS = FALLBACK_FREE.map((m) => m.id);

/** 目录 URL 归一：baseUrl 可能是裸 host 或带 /api/v1 的老 clinebot 形态；customPath 尊重用户自定义端点 */
export function catalogUrl(baseUrl, customPath) {
  const raw = String(baseUrl || "").trim() || DEFAULT_CLINE_BASE;
  const bare = raw.replace(/\/+$/, "").replace(/\/api\/v1\/?$/, "") || DEFAULT_CLINE_BASE;
  const p = String(customPath || "").trim();
  if (p && p !== "/models" && p !== FREE_CATALOG_PATH) return joinUrl(bare, p);
  return joinUrl(bare, FREE_CATALOG_PATH);
}

/** 只取 json.free（对象 {id,name,...} 或裸字符串两种形态都容忍） */
function pickFree(json) {
  const arr = Array.isArray(json?.free) ? json.free : [];
  const out = [];
  for (const m of arr) {
    if (typeof m === "string" && m.trim()) out.push({ id: m.trim() });
    else if (m && typeof m.id === "string" && m.id.trim()) out.push({ ...m, id: m.id.trim(), name: String(m.name || "") });
  }
  return out;
}

/**
 * 拉免费目录。
 * @returns {Promise<{ok:boolean, status:number, url:string, models:object[], ids:string[], error?:string}>}
 *   ok=false 时 models/ids 为空（兜底由调用方决定）；authorization 供私有/自定义目录可选透传。
 */
export async function fetchFreeCatalog({ baseUrl, customPath, fetchImpl, dispatcher, authorization, timeoutMs = 15_000 } = {}) {
  const url = catalogUrl(baseUrl, customPath);
  const impl = fetchImpl || compatFetch;
  const headers = { Accept: "application/json" };
  if (authorization) headers.Authorization = authorization;
  const opts = { headers };
  if (dispatcher) opts.dispatcher = dispatcher;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("cline free catalog timed out")), timeoutMs);
  timer.unref?.();
  opts.signal = controller.signal;
  try {
    const res = await impl(url, opts);
    const status = Number(res?.status) || 0;
    if (!res?.ok) return { ok: false, status, url, models: [], ids: [], error: `HTTP ${status}` };
    const json = await res.json().catch(() => null);
    const models = pickFree(json);
    if (!models.length) return { ok: false, status, url, models: [], ids: [], error: "empty free list" };
    return { ok: true, status, url, models, ids: models.map((m) => m.id) };
  } catch (err) {
    return { ok: false, status: 0, url, models: [], ids: [], error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}
