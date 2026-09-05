import { performance } from "node:perf_hooks";
import { isAutoModel } from "../auto.js";
import { errMsg } from "./helpers.js";
import { runHook } from "../plugins.js";
import { buildShareKeysHeader, SHARE_KEYS_HEADER } from "../providers/share-keys.js";
import { compatFetch, timeoutSignal } from "../compat.js";

const PEER_TIMEOUT_MS = 30_000;
const PEER_STATUS_TIMEOUT_MS = 2_000;

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
    return await compatFetch(`${peer.url}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, model }),
      signal: controller.signal,
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

export async function racePeerCandidates(candidates, ctx) {
  for (let i = 0; i < candidates.length; i += PEER_RACE_LIMIT) {
    const batch = candidates.slice(i, i + PEER_RACE_LIMIT);
    const prepared = (await Promise.all(batch.map((peer) => resolvePeerTarget(ctx, peer)))).filter(Boolean);
    if (!prepared.length) continue;
    const completed = await new Promise((resolve) => {
      const order = [];
      const total = prepared.length;
      for (const { peer, target } of prepared) {
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
            ctx.logError(ctx.model, status, res instanceof Error ? errMsg(res) : `peer ${status}`);
            ctx.evt("peer-error", { peer: peer.url, model: target, status, message: res instanceof Error ? errMsg(res) : null });
            order.push({ ok: false, peer, target, res, status });
          } else {
            order.push({ ok: true, peer, target, res, latencyMs });
          }
          if (order.length === total) resolve(order);
        });
      }
    });
    const winner = completed.find((o) => o.ok);
    if (winner) {
      for (const o of completed) {
        if (o === winner) continue;
        if (!o.ok) {
          await ctx.peers.recordError(o.peer.url);
          await ctx.peers.recordResult(o.peer.url, { ok: false });
        } else {
          await ctx.peers.recordResult(o.peer.url, { ok: true, latencyMs: o.latencyMs, model: o.target });
        }
      }
      return { peer: winner.peer, target: winner.target, res: winner.res, latencyMs: winner.latencyMs };
    }
    for (const o of completed) {
      await ctx.peers.recordError(o.peer.url);
      await ctx.peers.recordResult(o.peer.url, { ok: false });
    }
  }
  return null;
}
