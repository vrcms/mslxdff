import { buildFallbackInfo } from "../fallback.js";
import { relay, SLOW_TOTAL_MS } from "../stream.js";
import { racePeerCandidates } from "../peers.js";
import { runHook } from "../../plugins.js";

export async function handlePeerRelay({
  model,
  body,
  lastErr,
  requested,
  useAuto,
  lockModel,
  auto,
  peers,
  handlerCtx,
  evt,
  logCall,
  mark,
  perf0,
  stages,
  startedAt,
  plugins,
  res,
}) {
  evt("peer-race-start", { reqId: handlerCtx.reqId, model, peers: peers.ordered().length });
  const win =
    (await racePeerCandidates(peers.ordered(), handlerCtx)) ||
    (await racePeerCandidates(peers.orderedByLastError(), handlerCtx));
  if (!win) {
    evt("peer-race-lose", { reqId: handlerCtx.reqId, model });
    return { handled: false };
  }
  evt("peer-race-win", { reqId: handlerCtx.reqId, model, winPeer: win.peer.url, winTarget: win.target, latencyMs: win.latencyMs });
  await peers.recordResult(win.peer.url, { ok: true, latencyMs: win.latencyMs, model: win.target });
  logCall(win.target, win.res.status);
  const peerFallback = buildFallbackInfo({ requested, actual: win.target, lastErr, via: "peer", useAuto, lockModel });
  if (peerFallback?.fallback) evt("fallback-notice", { reqId: handlerCtx.reqId, requested, actual: win.target, reason: peerFallback.reason, notice: peerFallback.notice, via: "peer" });
  evt("relay-start", { reqId: handlerCtx.reqId, model: win.target, via: "peer", isStream: Boolean(body.stream), fallback: peerFallback });
  const out = await relay(res, win.res, body, {
    fallback: peerFallback,
    onFirstChunk: (d) => mark(`ttf-peer-${win.target}`),
    onDownstreamAbort: () => evt("client-abort", { reqId: handlerCtx.reqId, model: win.target, totalMs: Math.round(Date.now() - startedAt), stages: [...stages] }),
  });
  evt("relay-done", { reqId: handlerCtx.reqId, model: win.target, via: "peer", status: out.status, ttfMs: out.ttfMs, totalMs: out.totalMs, aborted: out.aborted, interrupted: out.interrupted ?? false, detail: out.detail ?? null });
  if (auto && out.status === 200) {
    const latencyMs = out.totalMs ?? win.latencyMs;
    if (out.detail?.stallHits > 0 || (latencyMs && latencyMs > SLOW_TOTAL_MS)) {
      void auto.recordError(win.target, { status: 200, slow: true, note: `peer slow ${latencyMs}ms` });
      void auto.recordLatency(win.target, latencyMs);
    } else {
      await auto.recordOk(win.target, { latencyMs });
    }
  }
  evt("result", { model: win.target, status: out.status, via: "peer", timing: win.res._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, detail: out.detail ?? null, fallback: peerFallback, requested, actual: win.target });
  evt("client-response", { requested, actual: win.target, via: "peer", fallback: peerFallback, status: out.status, reqId: handlerCtx.reqId });
  if (plugins?.length) runHook(plugins, "request:completed", { reqId: handlerCtx.reqId, requested, useAuto, hops: handlerCtx.hops, stream: Boolean(body.stream), durationMs: Date.now() - startedAt, via: "peer", status: out.status, actual: win.target, fallback: peerFallback }).catch(() => {});
  return { handled: true };
}
