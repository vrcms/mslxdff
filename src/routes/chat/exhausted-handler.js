import { relay } from "../stream.js";
import { json } from "../helpers.js";
import { performance } from "node:perf_hooks";

export async function handleExhaustedLocal({ res, body, lastErr, order, handlerCtx, evt, logCall, mark, perf0, stages, done, requested, useAuto }) {
  const model = lastErr?.model ?? handlerCtx.model;
  evt("exhausted-local", { reqId: handlerCtx.reqId, lastModel: lastErr?.model ?? model, lastStatus: lastErr?.status ?? 502, order });
  logCall(lastErr?.model ?? model, lastErr?.status ?? 502);
  if (lastErr?.upstream) {
    evt("relay-start", { reqId: handlerCtx.reqId, model: lastErr.model, via: "local-exhausted", isStream: Boolean(body.stream) });
    const out = await relay(res, lastErr.upstream, body, {
      onFirstChunk: (d) => mark(`ttf-${lastErr.model}`),
      onDownstreamAbort: () => evt("client-abort", { reqId: handlerCtx.reqId, model: lastErr.model, totalMs: Math.round(performance.now() - perf0), stages: [...stages] }),
    });
    evt("relay-done", { reqId: handlerCtx.reqId, model: lastErr.model, via: "local-exhausted", status: out.status, ttfMs: out.ttfMs, totalMs: out.totalMs, aborted: out.aborted, interrupted: out.interrupted ?? false, detail: out.detail ?? null });
    evt("result", { reqId: handlerCtx.reqId, model: lastErr.model, status: out.status, via: "local", timing: lastErr.upstream._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, detail: out.detail ?? null });
    return true;
  }
  evt("result", { reqId: handlerCtx.reqId, model, status: lastErr?.status ?? 502, via: "none", timing: null });
  done({ via: "none", status: lastErr?.status ?? 502, error: lastErr?.message || "all auto models failed" });
  json(res, 502, { error: lastErr?.message || "all auto models failed" });
  return true;
}

export async function handleExhaustedAll({ res, body, lastErr, order, requested, handlerCtx, evt, logCall, mark, perf0, stages }) {
  evt("exhausted-all", { reqId: handlerCtx.reqId, lastModel: lastErr?.model ?? requested, lastStatus: lastErr?.status ?? 502, order });
  logCall(lastErr?.model ?? requested, lastErr?.status ?? 502);
  if (lastErr?.upstream) {
    evt("relay-start", { reqId: handlerCtx.reqId, model: lastErr.model, via: "local-final", isStream: Boolean(body.stream) });
    const out = await relay(res, lastErr.upstream, body, {
      onFirstChunk: (d) => mark(`ttf-${lastErr.model}`),
      onDownstreamAbort: () => evt("client-abort", { reqId: handlerCtx.reqId, model: lastErr.model, totalMs: Math.round(performance.now() - perf0), stages: [...stages] }),
    });
    evt("relay-done", { reqId: handlerCtx.reqId, model: lastErr.model, via: "local-final", status: out.status, ttfMs: out.ttfMs, totalMs: out.totalMs, aborted: out.aborted, interrupted: out.interrupted ?? false, detail: out.detail ?? null });
    evt("result", { reqId: handlerCtx.reqId, model: lastErr.model, status: out.status, via: "local", timing: lastErr.upstream._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, detail: out.detail ?? null });
    return true;
  }
  evt("result", { reqId: handlerCtx.reqId, model: lastErr?.model ?? requested, status: lastErr?.status ?? 502, via: "none", timing: null });
  json(res, 502, { error: lastErr?.message || "all auto models failed" });
  return true;
}
