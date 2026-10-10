import { joinModelId } from "../model-id.js";
import { joinUrl } from "../base.js";

function creditsValue(c) {
  if (!c || !String(c).trim()) return 0;
  const m = String(c).match(/x([\d.]+)/);
  return m ? parseFloat(m[1]) : 999;
}

export function createModelsService({
  id = "workbuddy",
  baseUrl,
  modelsPath,
  fetchImpl,
  dispatcher,
  getKey,
  getAuth,
  maybeProactiveRefresh,
  refreshTokenFor,
  isAuthError,
  clock = Date.now,
} = {}) {
  const CACHE_TTL_MS = 10 * 60 * 1000;
  let cache = null;
  let fetchedAt = 0;

  async function execList(useKey, useAuth) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${id} models timed out`)), 15_000);
    try {
      const headers = {
        Accept: "application/json",
        "X-User-Id": useAuth?.uid || "",
        "X-Domain": useAuth?.domain || "www.codebuddy.cn",
        "X-Product": "SaaS",
        "User-Agent": "CLI/2.115.0 WorkBuddy/2.115.0",
        Origin: "https://www.codebuddy.cn",
        Referer: "https://www.codebuddy.cn/",
      };
      if (useKey) headers["Authorization"] = `Bearer ${useKey}`;
      const opts = { headers, signal: controller.signal };
      if (dispatcher) opts.dispatcher = dispatcher;
      return await fetchImpl(`${joinUrl(baseUrl, modelsPath)}`, opts);
    } finally {
      clearTimeout(timer);
    }
  }

  async function listModels() {
    const now = clock();
    if (cache && now - fetchedAt < CACHE_TTL_MS) return cache;
    // 逐 key 试到成功：单个 token 被上游撤销时整个目录不该空掉。2026-10-10 实测 4 个 token 里 3 个
    // 已失效，旧逻辑取 ring.next() 首个 key 401 即 return []，CLI 端表现为 `workbuddy models (0 total)`
    // → aggLoad 判 `!allowed.length` 把整家 workbuddy 跳过，用户侧就是「模型全没了」。
    const tried = new Set();
    let res = null;
    try {
      for (let i = 0; i < 8; i++) {
        const key = getKey ? getKey() : "";
        if (tried.has(key)) break; // ring 绕回已试过的号 = 没有新号了
        tried.add(key);
        const auth = getAuth ? getAuth(key) : null;
        if (auth && key) maybeProactiveRefresh?.(auth, key);
        let r = await execList(key, auth);
        if (!r.ok) {
          let t = "";
          try { t = await r.clone().text(); } catch {}
          if (isAuthError?.(r.status, t)) {
            const newKey = await refreshTokenFor?.(key, auth);
            if (newKey && !tried.has(newKey)) {
              tried.add(newKey);
              r = await execList(newKey, getAuth ? getAuth(newKey) : auth);
            }
          }
        }
        if (r.ok) { res = r; break; }
      }
      if (!res) return [];
      const json = await res.json().catch(() => ({}));
      // `/v3/config` 两种形状都出现过：`{code,msg,data}` 信封 / 产品文档裸放顶层
      const doc = json && typeof json === "object"
        ? (json.data && typeof json.data === "object" && !Array.isArray(json.data) ? json.data
          : (Array.isArray(json.models) || Array.isArray(json.agents) ? json : null))
        : null;
      const models = doc?.models;
      if (!Array.isArray(models)) return [];
      const sorted = [...models].sort((a, b) => creditsValue(a.credits) - creditsValue(b.credits));
      cache = sorted.filter((m) => m && typeof m.id === "string").map((m) => ({ ...m, id: joinModelId(id, m.id) }));
      fetchedAt = now;
      return cache;
    } catch {
      return [];
    }
  }

  async function preheat() {
    const t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : clock();
    try {
      const key = getKey ? getKey() : "";
      const auth = getAuth ? getAuth(key) : null;
      const headers = {
        Accept: "application/json",
        "X-User-Id": auth?.uid || "",
        "X-Domain": auth?.domain || "www.codebuddy.cn",
        "X-Product": "SaaS",
        "User-Agent": "CLI/2.115.0 WorkBuddy/2.115.0",
        Origin: "https://www.codebuddy.cn",
        Referer: "https://www.codebuddy.cn/",
      };
      if (key) headers["Authorization"] = `Bearer ${key}`;
      const opts = { headers };
      if (dispatcher) opts.dispatcher = dispatcher;
      const res = await fetchImpl(joinUrl(baseUrl, modelsPath), opts);
      try { if (res.body) await res.text().catch(() => {}); } catch {}
      const ms = Math.round(((typeof performance !== "undefined" && performance.now) ? performance.now() : clock()) - t0);
      return { ok: res.ok, status: res.status, ms };
    } catch (err) {
      const ms = Math.round(((typeof performance !== "undefined" && performance.now) ? performance.now() : clock()) - t0);
      return { ok: false, error: String(err?.message || err), ms };
    }
  }

  function clearCache() { cache = null; fetchedAt = 0; }

  return { listModels, preheat, clearCache, _getCache: () => cache };
}
