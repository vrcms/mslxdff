import { performance } from "node:perf_hooks";
import { isAutoModel } from "../auto.js";
import { errMsg } from "./helpers.js";
import { runHook } from "../plugins.js";
import { buildShareKeysHeader, SHARE_KEYS_HEADER } from "../providers/share-keys.js";
import { compatFetch, timeoutSignal, getUndici } from "../compat.js";

const PEER_TIMEOUT_MS = 30_000;
const PEER_STATUS_TIMEOUT_MS = 2_000;
const DEFAULT_PEER_CONNECT_TIMEOUT_MS = 3_000;

function peerConnectTimeoutMs() {
  const n = Number(process.env.MSLXDFF_PEER_CONNECT_TIMEOUT_MS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_PEER_CONNECT_TIMEOUT_MS;
}

// 连接级超时（DNS + TCP/TLS 握手）：黑洞节点（端口挂起）必须快速失败，
// 不能占用 30s 的响应超时（曾把一次请求拖到 92s）。仅 undici 可用时生效。
let peerDispatcher = null;
function getPeerDispatcher() {
  if (peerDispatcher) return peerDispatcher;
  const { Agent } = getUndici();
  if (!Agent) return null;
  try {
    peerDispatcher = new Agent({
      connect: { timeout: peerConnectTimeoutMs() },
      headersTimeout: PEER_TIMEOUT_MS,
      bodyTimeout: PEER_TIMEOUT_MS,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
    });
  } catch { peerDispatcher = null; }
  return peerDispatcher;
}

// 跨 caller 中继必须剥离 reasoning 加密态：encrypted_content 由上游按 caller（出口）签发，
// 换个节点转发会被拒（400 "reasoning encrypted_content was not issued to this caller"）。
// 明文 reasoning_content 保留（不绑定 caller，thinking 模式需要）。
export function stripCallerBoundReasoning(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return body;
  let changed = false;
  const out = messages.map((m) => {
    if (!m || m.role !== "assistant") return m;
    if (!Array.isArray(m.reasoning_items) || !m.reasoning_items.length) return m;
    changed = true;
    const copy = { ...m };
    delete copy.reasoning_items;
    return copy;
  });
  return changed ? { ...body, messages: out } : body;
}

function peerHealthTtlMs() {
  const n = Number(process.env.MSLXDFF_PEER_HEALTH_TTL_MS);
  return Number.isInteger(n) && n >= 0 ? n : 30_000;
}

const healthCache = new Map(); // url -> { at, data }
const healthInflight = new Map(); // url -> Promise

export function clearPeerHealthCache() {
  healthCache.clear();
  healthInflight.clear();
}

export async function peerHealthyModels(peer, { timeoutMs = PEER_STATUS_TIMEOUT_MS, fetchImpl = compatFetch } = {}) {
  const key = peer?.url || "";
  const ttl = peerHealthTtlMs();
  if (ttl > 0) {
    const hit = healthCache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.data;
    const inflight = healthInflight.get(key);
    if (inflight) return inflight;
  }
  const p = (async () => {
    try {
      const res = await fetchImpl(`${peer.url}/v1/models/status`, {
        headers: {
          "Authorization": `Bearer ${peer.token || ""}`,
          "Accept": "application/json",
        },
        signal: timeoutSignal(timeoutMs),
      });
      if (!res.ok) return [];
      const j = await res.json().catch(() => ({}));
      return (j.data || [])
        .filter((m) => m && typeof m.id === "string" && m.status === "normal")
        .map((m) => m.id);
    } catch {
      return [];
    }
  })();
  if (ttl > 0) {
    healthInflight.set(key, p);
    try {
      const data = await p;
      healthCache.set(key, { at: Date.now(), data });
      return data;
    } finally {
      healthInflight.delete(key);
    }
  }
  return p;
}

async function forwardToPeer(peer, body, model, hops) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PEER_TIMEOUT_MS);
  try {
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${peer.token}`,
      "x-mslxdff-hops": String(hops + 1),
      "x-mslxdff-model-lock": model,
      "Accept": "text/event-stream",
    };
    // ADR-0008：该模型命中的供应商若开启 share → 附带瞬时 key 给组员借用（opencode 恒排除）
    const shareHeader = buildShareKeysHeader(model);
    if (shareHeader) headers[SHARE_KEYS_HEADER] = shareHeader;
    const dispatcher = getPeerDispatcher();
    return await compatFetch(`${peer.url}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...stripCallerBoundReasoning(body), model }),
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
    });
  } catch (err) {
    return err;
  } finally {
    clearTimeout(timer);
  }
}

async function resolvePeerTarget(ctx, peer) {
  const prevModel = ctx.peers.stat(peer.url)?.model;
  const hot = ctx.peers.isHot(peer.url) && prevModel === ctx.model;
  if (hot) return { peer, target: prevModel };
  const isExplicit = !!ctx.model && !isAutoModel(ctx.model);
  if (isExplicit) {
    const healthy = await peerHealthyModels(peer);
    if (!healthy.length) {
      ctx.evt("peer-health", { peer: peer.url, healthy: [], count: 0, strict: true });
      return { peer, target: ctx.model };
    }
    ctx.evt("peer-health", { peer: peer.url, healthy, count: healthy.length, strict: true });
    return { peer, target: ctx.model };
  }
  const healthy = await peerHealthyModels(peer);
  if (!healthy.length) {
    await ctx.peers.recordError(peer.url);
    ctx.logError(ctx.model, 0, `peer ${peer.url} has no healthy models`);
    ctx.evt("peer-health", { peer: peer.url, healthy: [], count: 0 });
    return null;
  }
  ctx.evt("peer-health", { peer: peer.url, healthy, count: healthy.length });
  return { peer, target: healthy.includes(ctx.model) ? ctx.model : healthy[0] };
}

export const PEER_RACE_LIMIT = Number(process.env.MSLXDFF_PEER_RACE_LIMIT) > 0
  ? Number(process.env.MSLXDFF_PEER_RACE_LIMIT)
  : 3;

// 串行记账队列：失败/迟到成功的记录不阻塞赢家返回，同时避免并发写盘互相覆盖。
let peerRecordChain = Promise.resolve();
function recordLater(fn) {
  peerRecordChain = peerRecordChain.then(fn).catch(() => {});
}

export async function racePeerCandidates(candidates, ctx) {
  const tried = (ctx.triedUrls ??= new Set());
  const fresh = candidates.filter((p) => !tried.has(p.url));
  for (let i = 0; i < fresh.length; i += PEER_RACE_LIMIT) {
    const batch = fresh.slice(i, i + PEER_RACE_LIMIT);
    const prepared = (await Promise.all(batch.map((peer) => resolvePeerTarget(ctx, peer)))).filter(Boolean);
    if (!prepared.length) continue;
    const completed = await new Promise((resolve) => {
      const order = [];
      const total = prepared.length;
      let settled = false;
      const finish = (winner) => {
        if (settled) return;
        settled = true;
        resolve({ list: order, winner });
      };
      for (const { peer, target } of prepared) {
        tried.add(peer.url);
        ctx.evt("peer-request", { peer: peer.url, model: target, hops: ctx.hops + 1 });
        // 插件 hook：peer:beforeForward — 转发给组员前观察
        if (ctx.plugins?.length) {
          runHook(ctx.plugins, "peer:beforeForward", { reqId: ctx.reqId, peer: peer.url, model: target, hops: ctx.hops + 1 }).catch(() => {});
        }
        const t0 = performance.now();
        forwardToPeer(peer, ctx.body, target, ctx.hops).then((res) => {
          const latencyMs = Math.round(performance.now() - t0);
          const failed = res instanceof Error || res.status >= 400;
          ctx.evt("peer-forward", { peer: peer.url, model: target, hops: ctx.hops + 1, latencyMs, ok: !failed });
          // 插件 hook：peer:result — 组员响应后观察
          if (ctx.plugins?.length) {
            runHook(ctx.plugins, "peer:result", { reqId: ctx.reqId, peer: peer.url, model: target, ok: !failed, status: failed ? (res instanceof Error ? 502 : res.status) : res.status, latencyMs }).catch(() => {});
          }
          if (failed) {
            const status = res instanceof Error ? 502 : res.status;
            const failRec = { peer: peer.url, status, message: res instanceof Error ? errMsg(res) : null };
            if (Array.isArray(ctx.peerErrors)) ctx.peerErrors.push(failRec);
            ctx.logError(ctx.model, status, res instanceof Error ? `peer ${peer.url} ${errMsg(res)}` : `peer ${peer.url} ${status}`);
            ctx.evt("peer-error", { peer: peer.url, model: target, status, message: res instanceof Error ? errMsg(res) : null });
            order.push({ ok: false, peer, target, res, status });
            recordLater(() => ctx.peers.recordError(peer.url, { status }));
            recordLater(() => ctx.peers.recordResult(peer.url, { ok: false }));
            if (order.length === total) finish(null);
          } else {
            const entry = { ok: true, peer, target, res, latencyMs };
            order.push(entry);
            if (!settled) {
              // 第一个成功立即返回：不等慢/黑洞候选（迟到者的记账由各分支自理）
              finish(entry);
            } else {
              recordLater(() => ctx.peers.recordResult(peer.url, { ok: true, latencyMs, model: target }));
            }
          }
        });
      }
    });
    const winner = completed.winner;
    if (winner) {
      return { peer: winner.peer, target: winner.target, res: winner.res, latencyMs: winner.latencyMs };
    }
    // 全失败：补读失败响应体（诊断 + 调用者详情）。仅在"本轮无 winner"时执行，
    // 不拖慢成功路径；并行读、每 peer 上限 600ms，body 里才有 400/429 的真实原因。
    await Promise.all(completed.list.map(async (o) => {
      if (o.ok || !o.res || typeof o.res !== "object" || o.res instanceof Error) return;
      try {
        const snip = String(await Promise.race([
          o.res.clone().text(),
          new Promise((r) => { const t = setTimeout(() => r(""), 600); t.unref?.(); }),
        ])).replace(/\s+/g, " ").slice(0, 300);
        if (!snip) return;
        if (Array.isArray(ctx.peerErrors)) {
          const rec = ctx.peerErrors.find((x) => x.peer === o.peer.url && x.status === o.status && !x.message);
          if (rec) rec.message = snip;
        }
        ctx.logError(ctx.model, o.status, `peer ${o.peer.url} ${o.status} body=${snip}`);
      } catch {}
    }));
  }
  return null;
}
