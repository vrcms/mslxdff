import { buildFallbackInfo } from "../fallback.js";
import { relay, SLOW_TOTAL_MS, STREAM_TIMEOUT_MS, STALL_TIMEOUT_MS, SCORE_STALL_MS } from "../stream.js";
import { runHook } from "../../plugins.js";
import { performance } from "node:perf_hooks";

export async function handleLocalRelay({
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
}) {
  logCall(model, upRes.status);
  const fallback = buildFallbackInfo({ requested, actual: model, lastErr, via: "local", useAuto, lockModel });
  if (fallback?.fallback) evt("fallback-notice", { reqId: handlerCtx.reqId, requested, actual: model, reason: fallback.reason, notice: fallback.notice, via: "local" });
  evt("relay-start", { reqId: handlerCtx.reqId, model, via: "local", isStream: Boolean(body.stream), fallback });
  const out = await relay(res, upRes, body, {
    fallback,
    onFirstChunk: (delta) => {
      mark(`ttf-${model}`);
      evt("relay-first-chunk", { reqId: handlerCtx.reqId, model, ttfMs: delta });
      if (plugins?.length) runHook(plugins, "relay:first-chunk", { reqId: handlerCtx.reqId, requested, model, via: "local", ttfMs: delta }).catch(() => {});
    },
    onDownstreamAbort: () => {
      evt("client-abort", { reqId: handlerCtx.reqId, model, totalMs: Math.round(performance.now() - perf0), stages: [...stages] });
    },
  });
  evt("relay-done", { reqId: handlerCtx.reqId, model, via: "local", status: out.status, ttfMs: out.ttfMs, totalMs: out.totalMs, aborted: out.aborted, interrupted: out.interrupted ?? false, detail: out.detail ?? null });
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
    evt("client-response", { requested, actual: model, via: "local", fallback, status: out.status, interrupted: true, reqId: handlerCtx.reqId });
    if (plugins?.length) runHook(plugins, "request:completed", { reqId: handlerCtx.reqId, requested, useAuto, hops: handlerCtx.hops, stream: Boolean(body.stream), durationMs: Date.now() - startedAt, via: "local", status: out.status, actual: model, interrupted: true, fallback }).catch(() => {});
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
  if (!scoredSlow && auto && out.status === 200) {
    await auto.recordOk(model, { latencyMs });
  } else if (!scoredSlow && auto) {
    await auto.recordLatency(model, latencyMs);
  }
  evt("result", { model, status: out.status, via: "local", timing: upRes._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, detail: out.detail ?? null, fallback, requested, actual: model });
  evt("client-response", { requested, actual: model, via: "local", fallback, status: out.status, reqId: handlerCtx.reqId });
  if (plugins?.length) runHook(plugins, "request:completed", { reqId: handlerCtx.reqId, requested, useAuto, hops: handlerCtx.hops, stream: Boolean(body.stream), durationMs: Date.now() - startedAt, via: "local", status: out.status, actual: model, fallback }).catch(() => {});
  return { handled: true };
}
