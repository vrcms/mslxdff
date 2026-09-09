import { joinUrl, getUndici } from "../base.js";
import { compatFetch } from "../../compat.js";
import { joinModelId } from "../model-id.js";

const { UndiciFetch } = getUndici();

function isClineBotHost(baseUrl) {
  try { const u = new URL(baseUrl); return u.hostname === "api.cline.bot" || u.hostname.endsWith(".cline.bot"); } catch { return String(baseUrl).includes("cline.bot"); }
}

export function createModelsService({ id, baseUrl, modelsPath, fetchImpl, dispatcher, ring, loadKeys } = {}) {
  if (!fetchImpl) fetchImpl = UndiciFetch || compatFetch;
  const resolvedBase = String(baseUrl).trim().replace(/\/+$/, "");
  const resolvedPath = modelsPath || "/ai/cline/recommended-models";
  const CACHE_TTL = 10 * 60 * 1000;
  let cache = null;
  let fetchedAt = 0;

  // 离线兜底：对标官方 FALLBACK（free 数组实证含 z-ai/glm-5.3-flash）。
  // 上游挂了/401 时也不返回空数组，保证 -provider clinebot models 与 picks 仍有免费可用。
  const FALLBACK_FREE = [
    { id: "deepseek/deepseek-v4-flash", name: "deepseek-v4-flash" },
    { id: "z-ai/glm-5.3-flash", name: "glm-5.3-flash" },
    { id: "poolside/laguna-s-2.1:free", name: "laguna-s-2.1:free" },
  ];

  function fallbackList() {
    const out = FALLBACK_FREE.map((m) => ({ ...m, id: joinModelId(id, m.id) }));
    cache = out; fetchedAt = Date.now();
    return out;
  }

  // 端点归一化：官方取 {bareHost}/api/v1/ai/cline/recommended-models。
  // baseUrl 可能是裸 host（https://api.cline.bot）也可能是带 /api/v1 的，
  // 统一收敛到 …/api/v1/ai/cline/recommended-models；用户自定义 path 原样尊重。
  function resolveModelsUrl() {
    const custom = modelsPath && modelsPath !== "/models" && modelsPath !== "/ai/cline/recommended-models";
    if (custom) return joinUrl(resolvedBase, resolvedPath);
    const bare = resolvedBase.replace(/\/api\/v1\/?$/, "");
    return joinUrl(bare, "/api/v1/ai/cline/recommended-models");
  }

  async function listModels() {
    const now = Date.now();
    if (cache && now - fetchedAt < CACHE_TTL) return cache;
    const url = resolveModelsUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${id} models timed out`)), 15_000);
    try {
      const headers = { Accept: "application/json" };
      const key = (loadKeys ? loadKeys(id)[0] : null) || (ring ? ring.next() : null);
      if (key && !String(key).includes(".")) headers["Authorization"] = `Bearer ${key}`;
      const opts = { headers, signal: controller.signal };
      if (dispatcher) opts.dispatcher = dispatcher;
      const res = await fetchImpl(url, opts);
      if (!res.ok) return fallbackList();
      const json = await res.json().catch(() => ({}));
      if (isClineBotHost(resolvedBase) && Array.isArray(json.free)) {
        const out = json.free.filter((m) => m && typeof m.id === "string").map((m) => ({ ...m, id: joinModelId(id, m.id) }));
        if (!out.length) return fallbackList();
        cache = out; fetchedAt = now; return out;
      }
      const raw = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : Array.isArray(json) ? json : [];
      const out = raw.filter((m) => m && typeof m.id === "string").map((m) => ({ ...m, id: joinModelId(id, m.id) }));
      if (!out.length) return fallbackList();
      cache = out; fetchedAt = now; return out;
    } catch { return fallbackList(); } finally { clearTimeout(timer); }
  }

  async function preheat() {
    const url = resolveModelsUrl();
    const t0 = performance.now();
    try {
      const headers = { Accept: "application/json" };
      const key = (loadKeys ? loadKeys(id)[0] : null) || (ring ? ring.next() : null);
      if (key && !String(key).includes(".")) headers["Authorization"] = `Bearer ${key}`;
      const opts = { headers };
      if (dispatcher) opts.dispatcher = dispatcher;
      const res = await fetchImpl(url, opts);
      try { if (res.body) await res.text().catch(() => {}); } catch {}
      return { ok: res.ok, status: res.status, ms: Math.round(performance.now() - t0) };
    } catch (err) {
      return { ok: false, error: String(err?.message || err), ms: Math.round(performance.now() - t0) };
    }
  }

  return { listModels, preheat };
}
