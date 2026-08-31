import { relay, SLOW_TOTAL_MS, STREAM_TIMEOUT_MS, STALL_TIMEOUT_MS, SCORE_STALL_MS } from "../stream.js";
import { buildFallbackInfo } from "../fallback.js";
import { createRelayPipeline } from "./relay-pipeline.js";
import { hedgedFirstChunkRace } from "../hedge.js";

/** 薄适配：hedge 赛跑后按 winner 调 pipeline（复用 relay-pipeline 深模块） */
export async function handleHedge({
  upRes,
  model,
  body,
  order,
  idx,
  lastErr,
  requested,
  useAuto,
  lockModel,
  auto,
  peers,
  handlerCtx,
  evt,
  logCall,
  logError,
  mark,
  perf0,
  stages,
  startedAt,
  plugins,
  res,
  hedgeDelayMs,
}) {
  const d = hedgeDelayMs;
  try {
    const hedged = await hedgedFirstChunkRace({ localUpRes: upRes, peers, handlerCtx, hedgeDelayMs: d, evt });
    if (hedged && hedged.winner) {
      if (hedged.winner === "local") {
        const bufferedUpRes = { ...upRes, body: hedged.bufferedBody, headers: upRes.headers, status: upRes.status, _t: upRes._t };
        const pipeline = createRelayPipeline({
          relay,
          buildFallbackInfo,
          auto,
          plugins,
          evt,
          mark,
          logCall,
          logError,
          constants: { STREAM_TIMEOUT_MS, SLOW_TOTAL_MS, STALL_TIMEOUT_MS, SCORE_STALL_MS },
          startedAt,
          stages,
        });
        const r = await pipeline.execute({
          res,
          upRes: bufferedUpRes,
          body,
          requested,
          actual: model,
          lastErr,
          via: "local",
          lockModel,
          useAuto,
          handlerCtx,
          mark,
          perf0,
          stages,
          startedAt,
        });
        // 保留 hedged 语义：若超时则透传 needs fallback
        if (!r.handled) return { handled: false, upRes: null, lastErr: r.lastErr };
        return { handled: true };
      }
      if (hedged.winner === "peer" && hedged.peerInfo) {
        const win = hedged.peerInfo;
        evt("peer-race-win", { reqId: handlerCtx.reqId, model, winPeer: win.peer.url, winTarget: win.target, latencyMs: win.latencyMs, hedged: true, ttfMs: hedged.ttfMs });
        await peers.recordResult(win.peer.url, { ok: true, latencyMs: win.latencyMs, model: win.target });
        const bufferedPeerRes = { ...win.res, body: hedged.bufferedBody, headers: win.res.headers, status: win.res.status, _t: win.res._t };
        const pipeline = createRelayPipeline({
          relay,
          buildFallbackInfo,
          auto,
          plugins,
          evt,
          mark,
          logCall,
          logError: () => {},
          constants: { STREAM_TIMEOUT_MS, SLOW_TOTAL_MS, STALL_TIMEOUT_MS, SCORE_STALL_MS },
          startedAt,
          stages,
        });
        await pipeline.execute({
          res,
          upRes: bufferedPeerRes,
          body,
          requested,
          actual: win.target,
          lastErr,
          via: "peer",
          lockModel,
          useAuto,
          handlerCtx: { ...handlerCtx, model: win.target },
          mark: (n) => mark(n),
          perf0,
          stages,
          startedAt,
        });
        return { handled: true };
      }
    }
    if (hedged && hedged.needsPeer) {
      return { handled: false, upRes: null, lastErr, needsPeer: true };
    }
    if (!hedged || !hedged.winner) {
      evt("hedge-both-fail", { reqId: handlerCtx.reqId, model });
      if (!hedged) {
        if (auto) await auto.recordError(model, { status: 502, slow: false, note: "hedge both fail" });
        const err = { model, upstream: null, status: 502, message: "hedge both failed" };
        return { handled: false, upRes: null, lastErr: err };
      }
      return { handled: false, upRes: null, lastErr };
    }
    return { handled: false, upRes: null, lastErr };
  } catch (hedgeErr) {
    evt("hedge-error", { reqId: handlerCtx.reqId, model, error: String(hedgeErr?.message || hedgeErr).slice(0, 300) });
    return { handled: false, upRes, lastErr };
  }
}
