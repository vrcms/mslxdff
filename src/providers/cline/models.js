import { joinUrl, getUndici } from "../base.js";
import { compatFetch } from "../../compat.js";
import { joinModelId } from "../model-id.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fetchFreeCatalog, catalogUrl, FALLBACK_FREE as BUNDLED_FREE } from "./free-catalog.js";

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

  // 离线兜底：与上游 recommended-models 的 free 对齐（常量在 free-catalog.js，2026-09-20 实测 5 个）。
  // 上游挂了/401 时也不返回空数组，保证 -provider cline models 与 picks 仍有免费可用。

  function fallbackList() {
    const out = BUNDLED_FREE.map((m) => ({ ...m, id: joinModelId(id, m.id) }));
    cache = out; fetchedAt = Date.now();
    return out;
  }

  // 端点归一化：官方取 {bareHost}/api/v1/ai/cline/recommended-models（URL 拼装与 CLI 共用 free-catalog.catalogUrl）。
  // baseUrl 可能是裸 host（https://api.cline.bot）也可能是带 /api/v1 的，统一收敛；用户自定义 path 原样尊重。
  function resolveModelsUrl() {
    const custom = modelsPath && modelsPath !== "/models" && modelsPath !== "/ai/cline/recommended-models";
    if (custom) return joinUrl(resolvedBase, resolvedPath);
    return catalogUrl(resolvedBase);
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
      if (isClineBotHost(resolvedBase) && json && typeof json === "object") {
        const all = [];
        for (const k of ["free", "clinePass"]) {
          const arr = Array.isArray(json[k]) ? json[k] : null;
          if (!arr || !arr.length) continue;
          for (const m of arr) {
            if (!m || typeof m.id !== "string") continue;
            const mid = joinModelId(id, m.id);
            if (!all.some((x) => x.id === mid)) all.push({ ...m, id: mid });
          }
        }
        if (!all.length) return fallbackList();
        cache = all; fetchedAt = now; return all;
      }
      const raw = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : Array.isArray(json) ? json : [];
      const out = raw.filter((m) => m && typeof m.id === "string").map((m) => ({ ...m, id: joinModelId(id, m.id) }));
      if (!out.length) return fallbackList();
      cache = out; fetchedAt = now; return out;
    } catch { return fallbackList(); } finally { clearTimeout(timer); }
  }

  // 每次 daemon 启动自检 free 列表（server-lifecycle 显式调 checkFreeUpdates，不经 dispatcher.preheat）：
  // 对比快照报增删并留痕（daemon.log），顺带把结果填缓存（省一次 listModels 请求）。
  // 快照路径由 index.js 注入 logDir 下文件；未注入时仅跳过自检，不影响拉取。
  function readSnapshotFree() {
    try { const j = JSON.parse(readFileSync(snapshotPath, "utf8")); return Array.isArray(j?.free) ? j.free : null; } catch { return null; }
  }

  function writeSnapshotFree(ids) {
    try {
      mkdirSync(dirname(snapshotPath), { recursive: true });
      writeFileSync(snapshotPath, JSON.stringify({ ts: Date.now(), free: ids }, null, 2));
    } catch {}
  }

  // Note: cline free 目录三处同源（CLI 直查/聚合目录/兜底，统一在 free-catalog.js）+ daemon 启动自检快照（diff 写 daemon.log，不自动改 picks）— 见 .agents/notes/implemented/bug-fix/2026-09-16-clinebot-free-catalog-unify.md
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

  // 启动自检入口：拉 recommended-models → 填缓存 → 对比快照报 free 增删（拉取与 CLI 共用 free-catalog.fetchFreeCatalog）。
  async function checkFreeUpdates() {
    const t0 = performance.now();
    const key = (loadKeys ? loadKeys(id)[0] : null) || (ring ? ring.next() : null);
    const authorization = key && !String(key).includes(".") ? `Bearer ${key}` : undefined;
    const cat = await fetchFreeCatalog({ baseUrl: resolvedBase, fetchImpl, dispatcher, authorization });
    const ms = () => Math.round(performance.now() - t0);
    const httpOk = cat.status >= 200 && cat.status < 300;
    if (!httpOk || !cat.models.length || !isClineBotHost(resolvedBase)) {
      return { ok: httpOk, status: cat.status, ...(httpOk ? {} : { error: cat.error }), ms: ms() };
    }
    const valid = cat.models;
    // 注意：只做快照 diff，不碰 listModels 的合并缓存——缓存里是 free+clinePass 全量，
    // 这里 cat.models 只有 free，写进去会把 pass 挤掉 10 分钟（daemon 启动后 /v1/models 就缺 pass）。
    let change = null;
    if (snapshotPath) { try { change = detectFreeChanges(valid.map((m) => m.id)); } catch {} }
    return {
      ok: true,
      status: cat.status,
      ms: ms(),
      ...(change?.added ? { freeAdded: change.added, freeRemoved: change.removed } : {}),
    };
  }

  // preheat 保留为别名：dispatcher 已不再调 cline，手动/测试/未来钩子仍可用，行为与自检一致
  async function preheat() {
    return checkFreeUpdates();
  }

  return { listModels, preheat, checkFreeUpdates };
}
