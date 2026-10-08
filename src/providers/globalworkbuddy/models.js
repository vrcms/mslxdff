// 目录服务：`GET /v3/config` → 带 `globalworkbuddy/` 前缀的模型表，10 分钟缓存。
// 三条取证结论落在这里：① 国内版的 console 目录在国际版恒 500，**不留那条兜底路径**；
// ② 目录不随 UA 变（结论 B），所以 UA 只是排障变量；③ 取数失败要**标来源**回落，
//    让上层能分清「真目录」与「兜底表」—— 拿兜底表冒充上游目录去烧积分是最坏情况。
import { compatFetch, timeoutSignal } from "../../compat.js";
import { joinUrl } from "../base.js";
import { joinModelId } from "../model-id.js";
import { BASE, MODELS_PATH, MODELS_CACHE_MS, JSON_TIMEOUT_MS } from "./constants.js";
import { catalogHeaders } from "./headers.js";
import { unwrapConfigDocument, parseModelCatalog, fallbackCatalog } from "./catalog.js";
import { classifyUpstreamError } from "./errors.js";

export function createModelsService({
  id = "globalworkbuddy",
  baseUrl = BASE,
  fetchImpl,
  dispatcher,
  getCred,              // async () => cred | null（第一个可用国际号）
  authService,
  clock = Date.now,
} = {}) {
  if (!fetchImpl) fetchImpl = compatFetch;
  const resolvedBase = String(baseUrl || BASE).trim().replace(/\/+$/, "");
  let cache = null;          // { rows, source, fetchedAt }
  let refreshInFlight = null;

  async function exec(cred) {
    const opts = { headers: catalogHeaders(cred), signal: timeoutSignal(JSON_TIMEOUT_MS) };
    if (dispatcher) opts.dispatcher = dispatcher;
    return fetchImpl(joinUrl(resolvedBase, MODELS_PATH), opts);
  }

  async function readOnce(cred) {
    const res = await exec(cred);
    if (!res.ok) {
      let text = "";
      try { text = await res.clone().text(); } catch {}
      return { ok: false, kind: classifyUpstreamError(res.status, text).kind, status: res.status };
    }
    const json = await res.json().catch(() => ({}));
    const rows = parseModelCatalog(unwrapConfigDocument(json));
    if (!rows.length) return { ok: false, kind: "empty", status: res.status };
    return { ok: true, rows, status: res.status };
  }

  /** 真正打上游：401/会话失效时刷一次再来；失败回落兜底表（并保留上次成功结果优先）。 */
  async function fetchLive() {
    const cred = typeof getCred === "function" ? await getCred() : null;
    if (!cred?.accessToken) return { rows: fallbackCatalog(), source: "fallback", reason: "no-credential" };
    let r = await readOnce(cred);
    if (!r.ok && r.kind === "session_dead" && authService && !refreshInFlight) {
      refreshInFlight = (async () => {
        const nk = await authService.refreshTokenFor?.(cred);
        return nk ? { ...cred, accessToken: nk } : null;
      })();
      try {
        const cred2 = await refreshInFlight;
        if (cred2) r = await readOnce(cred2);
      } finally { refreshInFlight = null; }
    }
    if (r.ok) return { rows: r.rows, source: "upstream", status: r.status };
    // 上游失败：先吃旧缓存（哪怕过期），再退兜底表 —— 目录列表空掉比目录旧更伤体验
    if (cache?.rows?.length) return { rows: cache.rows, source: cache.source, stale: true, reason: r.kind };
    return { rows: fallbackCatalog(), source: "fallback", reason: r.kind };
  }

  async function listModels() {
    const now = clock();
    if (cache && cache.source === "upstream" && now - cache.fetchedAt < MODELS_CACHE_MS) {
      return cache.rows.map((m) => ({ ...m, id: joinModelId(id, m.id) }));
    }
    const out = await fetchLive();
    cache = { rows: out.rows, source: out.source, fetchedAt: now, reason: out.reason || "" };
    return cache.rows.map((m) => ({ ...m, id: joinModelId(id, m.id) }));
  }

  /** 预热：只探连通与鉴权，不解析结果；失败也回结构，供启动日志一行诊断。 */
  async function preheat() {
    const t0 = clock();
    try {
      const cred = typeof getCred === "function" ? await getCred() : null;
      if (!cred?.accessToken) return { ok: false, error: "no-credential", ms: 0 };
      const res = await exec(cred);
      try { if (res.body) await res.text().catch(() => {}); } catch {}
      return { ok: res.ok, status: res.status, ms: Math.round(clock() - t0) };
    } catch (err) {
      return { ok: false, error: String(err?.message || err), ms: Math.round(clock() - t0) };
    }
  }

  function clearCache() { cache = null; }
  /** 给状态卡/诊断用：当前列表来自上游还是兜底。 */
  function catalogSource() { return cache ? { source: cache.source, fetchedAt: cache.fetchedAt, reason: cache.reason } : null; }

  return { listModels, preheat, clearCache, catalogSource, _getCache: () => cache };
}
