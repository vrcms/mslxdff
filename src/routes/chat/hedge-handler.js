import { buildFallbackInfo } from "../fallback.js";
import { relay, SLOW_TOTAL_MS, STREAM_TIMEOUT_MS, STALL_TIMEOUT_MS, SCORE_STALL_MS } from "../stream.js";
import { hedgedFirstChunkRace } from "../hedge.js";
import { runHook } from "../../plugins.js";

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
  const isStream = Boolean(body.stream);
  const d = hedgeDelayMs;
  // hedge 已在外层判断 doHedge，这里直接执行赛跑
  try {
    const hedged = await hedgedFirstChunkRace({ localUpRes: upRes, peers, handlerCtx, hedgeDelayMs: d, evt });
    if (hedged && hedged.winner) {
      if (hedged.winner === "local") {
        const fallback = buildFallbackInfo({ requested, actual: model, lastErr, via: "local", useAuto, lockModel });
        if (fallback?.fallback) evt("fallback-notice", { reqId: handlerCtx.reqId, requested, actual: model, reason: fallback.reason, notice: fallback.notice, via: "local" });
        evt("relay-start", { reqId: handlerCtx.reqId, model, via: "local", isStream, fallback, hedged: true });
        const bufferedUpRes = { ...upRes, body: hedged.bufferedBody, headers: upRes.headers, status: upRes.status, _t: upRes._t };
        logCall(model, bufferedUpRes.status);
        const out = await relay(res, bufferedUpRes, body, {
          fallback,
          onFirstChunk: (delta) => {
            mark(`ttf-${model}`);
            evt("relay-first-chunk", { reqId: handlerCtx.reqId, model, ttfMs: delta, hedged: true, via: "local" });
            if (plugins?.length) runHook(plugins, "relay:first-chunk", { reqId: handlerCtx.reqId, requested, model, via: "local", ttfMs: delta }).catch(() => {});
          },
          onDownstreamAbort: () => {
            evt("client-abort", { reqId: handlerCtx.reqId, model, totalMs: Math.round(perf0 ? (Date.now() - startedAt) : 0), stages: [...stages] });
          },
        });
        evt("relay-done", { reqId: handlerCtx.reqId, model, via: "local", status: out.status, ttfMs: out.ttfMs ?? hedged.ttfMs, totalMs: out.totalMs, aborted: out.aborted, interrupted: out.interrupted ?? false, detail: out.detail ?? null, hedged: true });
        if (out.status === STREAM_TIMEOUT_MS) {
          if (auto) await auto.recordError(model, { status: 502, slow: true, note: `stream timeout ${STREAM_TIMEOUT_MS}ms` });
          const err = { model, upstream: null, status: 502, message: `stream timed out after ${STREAM_TIMEOUT_MS}ms` };
          logError(model, 502, `stream timeout ${STREAM_TIMEOUT_MS}ms`);
          evt("upstream-error", { reqId: handlerCtx.reqId, model, status: 502, message: "stream timeout", timing: null });
          evt("fallback", { reqId: handlerCtx.reqId, from: model, to: order[idx + 1] ?? null, reason: "stream timeout" });
          return { handled: false, upRes: null, lastErr: err };
        }
        if (out.interrupted) {
          if (auto) {
            await auto.recordError(model, { status: 200, slow: true, note: `stall ${STALL_TIMEOUT_MS}ms` });
            await auto.recordLatency(model, out.totalMs ?? (Date.now() - startedAt));
          }
          evt("slow-model", { model, elapsedMs: out.totalMs ?? (Date.now() - startedAt), threshold: STALL_TIMEOUT_MS, interrupted: true, detail: out.detail ?? null });
          logCall(model, 200);
          evt("result", { model, status: out.status, via: "local", timing: upRes._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, interrupted: true, detail: out.detail ?? null, fallback, requested, actual: model });
          evt("client-response", { requested, actual: model, via: "local", fallback, status: out.status, reqId: handlerCtx.reqId });
          if (plugins?.length) runHook(plugins, "request:completed", { reqId: handlerCtx.reqId, requested, useAuto, hops: handlerCtx.hops, stream: isStream, durationMs: Date.now() - startedAt, via: "local", status: out.status, actual: model, interrupted: true, fallback }).catch(() => {});
          return { handled: true };
        }
        const elapsed = Date.now() - startedAt;
        const latencyMs = out.totalMs ?? elapsed;
        let scoredSlow = false;
        if (SLOW_TOTAL_MS && auto && elapsed > SLOW_TOTAL_MS && out.status === 200) {
          void auto.recordError(model, { status: 200, slow: true, note: `slow ${elapsed}ms` });
          void auto.recordLatency(model, latencyMs);
          evt("slow-model", { model, elapsedMs: elapsed, threshold: SLOW_TOTAL_MS, reason: "total", detail: out.detail ?? null });
          scoredSlow = true;
        }
        if (out.detail?.stallHits > 0 && auto && out.status === 200) {
          void auto.recordError(model, { status: 200, slow: true, note: `stall ${out.detail.stallHits}x gap>${SCORE_STALL_MS}ms maxGap ${out.detail.maxGapMs}ms` });
          void auto.recordLatency(model, latencyMs);
          evt("slow-model", { model, elapsedMs: elapsed, threshold: SCORE_STALL_MS, reason: "stall", stallHits: out.detail.stallHits, maxGapMs: out.detail.maxGapMs, detail: out.detail ?? null });
          scoredSlow = true;
        }
        if (!scoredSlow && auto && out.status === 200) await auto.recordOk(model, { latencyMs });
        else if (!scoredSlow && auto) await auto.recordLatency(model, latencyMs);
        evt("result", { model, status: out.status, via: "local", timing: upRes._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, detail: out.detail ?? null, fallback, requested, actual: model, hedged: true });
        evt("client-response", { requested, actual: model, via: "local", fallback, status: out.status, reqId: handlerCtx.reqId });
        if (plugins?.length) runHook(plugins, "request:completed", { reqId: handlerCtx.reqId, requested, useAuto, hops: handlerCtx.hops, stream: isStream, durationMs: Date.now() - startedAt, via: "local", status: out.status, actual: model, fallback }).catch(() => {});
        return { handled: true };
      } else if (hedged.winner === "peer" && hedged.peerInfo) {
        const win = hedged.peerInfo;
        evt("peer-race-win", { reqId: handlerCtx.reqId, model, winPeer: win.peer.url, winTarget: win.target, latencyMs: win.latencyMs, hedged: true, ttfMs: hedged.ttfMs });
        await peers.recordResult(win.peer.url, { ok: true, latencyMs: win.latencyMs, model: win.target });
        logCall(win.target, win.res.status);
        const peerFallback = buildFallbackInfo({ requested, actual: win.target, lastErr, via: "peer", useAuto, lockModel });
        if (peerFallback?.fallback) evt("fallback-notice", { reqId: handlerCtx.reqId, requested, actual: win.target, reason: peerFallback.reason, notice: peerFallback.notice, via: "peer" });
        evt("relay-start", { reqId: handlerCtx.reqId, model: win.target, via: "peer", isStream, fallback: peerFallback, hedged: true });
        const bufferedPeerRes = { ...win.res, body: hedged.bufferedBody, headers: win.res.headers, status: win.res.status, _t: win.res._t };
        const out = await relay(res, bufferedPeerRes, body, {
          fallback: peerFallback,
          onFirstChunk: (d) => mark(`ttf-peer-${win.target}`),
          onDownstreamAbort: () => evt("client-abort", { reqId: handlerCtx.reqId, model: win.target, totalMs: Math.round(perf0 ? (Date.now() - startedAt) : 0), stages: [...stages] }),
        });
        evt("relay-done", { reqId: handlerCtx.reqId, model: win.target, via: "peer", status: out.status, ttfMs: out.ttfMs ?? hedged.ttfMs, totalMs: out.totalMs, aborted: out.aborted, interrupted: out.interrupted ?? false, detail: out.detail ?? null, hedged: true });
        if (auto && out.status === 200) {
          const latencyMs = out.totalMs ?? win.latencyMs;
          if (out.detail?.stallHits > 0 || (latencyMs && latencyMs > SLOW_TOTAL_MS)) {
            void auto.recordError(win.target, { status: 200, slow: true, note: `peer slow ${latencyMs}ms` });
            void auto.recordLatency(win.target, latencyMs);
          } else {
            await auto.recordOk(win.target, { latencyMs });
          }
        }
        evt("result", { model: win.target, status: out.status, via: "peer", timing: win.res._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, detail: out.detail ?? null, fallback: peerFallback, requested, actual: win.target, hedged: true });
        evt("client-response", { requested, actual: win.target, via: "peer", fallback: peerFallback, status: out.status, reqId: handlerCtx.reqId });
        if (plugins?.length) runHook(plugins, "request:completed", { reqId: handlerCtx.reqId, requested, useAuto, hops: handlerCtx.hops, stream: isStream, durationMs: Date.now() - startedAt, via: "peer", status: out.status, actual: win.target, fallback: peerFallback }).catch(() => {});
        return { handled: true };
      }
    }
    if (hedged && hedged.needsPeer) {
      return { handled: false, upRes: null, lastErr, needsPeer: true };
    } else if (!hedged || !hedged.winner) {
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
    // 回退到串行
    return { handled: false, upRes, lastErr };
  }
}
