import { joinUrl, getUndici } from "../base.js";
import { joinModelId } from "../model-id.js";

const { UndiciFetch } = getUndici();

function isClineBotHost(baseUrl) {
  try { const u = new URL(baseUrl); return u.hostname === "api.cline.bot" || u.hostname.endsWith(".cline.bot"); } catch { return String(baseUrl).includes("cline.bot"); }
}

export function createModelsService({ id, baseUrl, modelsPath, fetchImpl, dispatcher, ring, loadKeys } = {}) {
  if (!fetchImpl) fetchImpl = UndiciFetch || fetch;
  const resolvedBase = String(baseUrl).trim().replace(/\/+$/, "");
  const resolvedPath = modelsPath || "/ai/cline/recommended-models";
  const CACHE_TTL = 10 * 60 * 1000;
  let cache = null;
  let fetchedAt = 0;

  async function listModels() {
    const now = Date.now();
    if (cache && now - fetchedAt < CACHE_TTL) return cache;
    const url = joinUrl(resolvedBase, resolvedPath);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${id} models timed out`)), 15_000);
    try {
      const headers = { Accept: "application/json" };
      const key = (loadKeys ? loadKeys(id)[0] : null) || (ring ? ring.next() : null);
      if (key && !String(key).includes(".")) headers["Authorization"] = `Bearer ${key}`;
      const opts = { headers, signal: controller.signal };
      if (dispatcher) opts.dispatcher = dispatcher;
      const res = await fetchImpl(url, opts);
      if (!res.ok) return [];
      const json = await res.json().catch(() => ({}));
      if (isClineBotHost(resolvedBase) && Array.isArray(json.free)) {
        const out = json.free.filter((m) => m && typeof m.id === "string").map((m) => ({ ...m, id: joinModelId(id, m.id) }));
        cache = out; fetchedAt = now; return out;
      }
      const raw = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : Array.isArray(json) ? json : [];
      const out = raw.filter((m) => m && typeof m.id === "string").map((m) => ({ ...m, id: joinModelId(id, m.id) }));
      cache = out; fetchedAt = now; return out;
    } catch { return []; } finally { clearTimeout(timer); }
  }

  async function preheat() {
    const url = joinUrl(resolvedBase, resolvedPath);
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
