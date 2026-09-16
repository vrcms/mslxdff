import { joinUrl, getUndici } from "../base.js";
import { compatFetch } from "../../compat.js";
import { joinModelId } from "../model-id.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const { UndiciFetch } = getUndici();

function isClineBotHost(baseUrl) {
  try { const u = new URL(baseUrl); return u.hostname === "api.cline.bot" || u.hostname.endsWith(".cline.bot"); } catch { return String(baseUrl).includes("cline.bot"); }
}

export function createModelsService({ id, baseUrl, modelsPath, fetchImpl, dispatcher, ring, loadKeys, snapshotPath } = {}) {
  if (!fetchImpl) fetchImpl = UndiciFetch || compatFetch;
  const resolvedBase = String(baseUrl).trim().replace(/\/+$/, "");
  const resolvedPath = modelsPath || "/ai/cline/recommended-models";
  const CACHE_TTL = 10 * 60 * 1000;
  let cache = null;
  let fetchedAt = 0;

  // 离线兜底：与上游 recommended-models 的 free 对齐（2026-09-16 实测 5 个）。
  // 上游挂了/401 时也不返回空数组，保证 -provider clinebot models 与 picks 仍有免费可用。
  const FALLBACK_FREE = [
    { id: "cline-free/deepseek-v4.1-flash", name: "deepseek-v4.1-flash" },
    { id: "cline-free/muse-spark-1.3-contributor", name: "muse-spark-1.3-contributor" },
    { id: "z-ai/glm-5.3-flash", name: "glm-5.3-flash" },
    { id: "cline-free/solar-pro4", name: "solar-pro4" },
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

  // 每次 daemon 启动（server-lifecycle → dispatcher.preheat）自检 free 列表：
  // 对比快照报增删并留痕（daemon.log），顺带把结果填缓存（省一次 listModels 请求）。
  // 快照路径由 index.js 注入 logDir 下文件；未注入时仅跳过自检，不影响预热。
  function readSnapshotFree() {
    try { const j = JSON.parse(readFileSync(snapshotPath, "utf8")); return Array.isArray(j?.free) ? j.free : null; } catch { return null; }
  }

  function writeSnapshotFree(ids) {
    try {
      mkdirSync(dirname(snapshotPath), { recursive: true });
      writeFileSync(snapshotPath, JSON.stringify({ ts: Date.now(), free: ids }, null, 2));
    } catch {}
  }

  // Note: clinebot free 目录三处同源（CLI 直查/聚合目录/兜底）+ daemon 启动自检快照（diff 写 daemon.log，不自动改 picks）— 见 .agents/notes/implemented/bug-fix/2026-09-16-clinebot-free-catalog-unify.md
  function detectFreeChanges(ids) {
    const prev = readSnapshotFree();
    if (!prev) {
      writeSnapshotFree(ids);
      console.log(`[${id}] free snapshot created (${ids.length} models)`);
      return { first: true };
    }
    const added = ids.filter((x) => !prev.includes(x));
    const removed = prev.filter((x) => !ids.includes(x));
    if (!added.length && !removed.length) return { unchanged: true };
    writeSnapshotFree(ids);
    const parts = [];
    if (added.length) parts.push(`+${added.join(" +")}`);
    if (removed.length) parts.push(`-${removed.join(" -")}`);
    console.log(`[${id}] free models updated (${ids.length} total): ${parts.join(" ")}`);
    return { added, removed };
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
      let freeIds = null;
      try {
        const text = await res.text().catch(() => "");
        if (res.ok && text && isClineBotHost(resolvedBase)) {
          const json = JSON.parse(text);
          if (Array.isArray(json.free)) {
            const valid = json.free.filter((m) => m && typeof m.id === "string");
            if (valid.length) {
              cache = valid.map((m) => ({ ...m, id: joinModelId(id, m.id) }));
              fetchedAt = Date.now();
              freeIds = valid.map((m) => m.id);
            }
          }
        }
      } catch {}
      let change = null;
      if (freeIds && snapshotPath) { try { change = detectFreeChanges(freeIds); } catch {} }
      return {
        ok: res.ok,
        status: res.status,
        ms: Math.round(performance.now() - t0),
        ...(change?.added ? { freeAdded: change.added, freeRemoved: change.removed } : {}),
      };
    } catch (err) {
      return { ok: false, error: String(err?.message || err), ms: Math.round(performance.now() - t0) };
    }
  }

  return { listModels, preheat };
}
