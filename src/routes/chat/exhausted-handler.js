import { relay } from "../stream.js";
import { json } from "../helpers.js";
import { performance } from "node:perf_hooks";

export async function handleExhaustedLocal({ res, body, lastErr, order, handlerCtx, evt, logCall, mark, perf0, stages, done, requested, useAuto, deps = {} }) {
  const { relay: relayImpl = relay } = deps;
  const model = lastErr?.model ?? handlerCtx.model;
  evt("exhausted-local", { reqId: handlerCtx.reqId, lastModel: lastErr?.model ?? model, lastStatus: lastErr?.status ?? 502, order });
  logCall(lastErr?.model ?? model, lastErr?.status ?? 502);
  if (lastErr?.upstream) {
    evt("relay-start", { reqId: handlerCtx.reqId, model: lastErr.model, via: "local-exhausted", isStream: Boolean(body.stream) });
    const out = await relayImpl(res, lastErr.upstream, body, {
      onFirstChunk: (d) => mark(`ttf-${lastErr.model}`),
      onDownstreamAbort: () => evt("client-abort", { reqId: handlerCtx.reqId, model: lastErr.model, totalMs: Math.round(performance.now() - perf0), stages: [...stages] }),
    });
    evt("relay-done", { reqId: handlerCtx.reqId, model: lastErr.model, via: "local-exhausted", status: out.status, ttfMs: out.ttfMs, totalMs: out.totalMs, aborted: out.aborted, interrupted: out.interrupted ?? false, detail: out.detail ?? null });
    evt("result", { reqId: handlerCtx.reqId, model: lastErr.model, status: out.status, via: "local", timing: lastErr.upstream._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, detail: out.detail ?? null });
    evt("client-response", { requested, actual: lastErr.model, via: "local", fallback: false, status: out.status, reqId: handlerCtx.reqId });
    // 最后一站：relay 超时路径不写响应（设计留给上层 failover），这里没有上层，必须自己收尾
    if (out.timedOut) {
      json(res, 502, { error: out.detail?.upstreamError ? `upstream error: ${out.detail.upstreamError}` : `stream timed out after ${out.totalMs}ms` });
    }
    return true;
  }
  evt("result", { reqId: handlerCtx.reqId, model, status: lastErr?.status ?? 502, via: "none", timing: null });
  evt("client-response", { requested, actual: model, via: "none", fallback: false, status: lastErr?.status ?? 502, reqId: handlerCtx.reqId });
  done({ via: "none", status: lastErr?.status ?? 502, error: lastErr?.message || "all auto models failed" });
  json(res, 502, { error: lastErr?.message || "all auto models failed" });
  return true;
}

export async function handleExhaustedAll({ res, body, lastErr, order, requested, handlerCtx, evt, logCall, mark, perf0, stages, deps = {} }) {
  const { relay: relayImpl = relay } = deps;
  evt("exhausted-all", { reqId: handlerCtx.reqId, lastModel: lastErr?.model ?? requested, lastStatus: lastErr?.status ?? 502, order });
  logCall(lastErr?.model ?? requested, lastErr?.status ?? 502);
  if (lastErr?.upstream) {
    evt("relay-start", { reqId: handlerCtx.reqId, model: lastErr.model, via: "local-final", isStream: Boolean(body.stream) });
    const out = await relayImpl(res, lastErr.upstream, body, {
      onFirstChunk: (d) => mark(`ttf-${lastErr.model}`),
      onDownstreamAbort: () => evt("client-abort", { reqId: handlerCtx.reqId, model: lastErr.model, totalMs: Math.round(performance.now() - perf0), stages: [...stages] }),
    });
    evt("relay-done", { reqId: handlerCtx.reqId, model: lastErr.model, via: "local-final", status: out.status, ttfMs: out.ttfMs, totalMs: out.totalMs, aborted: out.aborted, interrupted: out.interrupted ?? false, detail: out.detail ?? null });
    evt("result", { reqId: handlerCtx.reqId, model: lastErr.model, status: out.status, via: "local", timing: lastErr.upstream._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, detail: out.detail ?? null });
    evt("client-response", { requested, actual: lastErr.model, via: "local", fallback: false, status: out.status, reqId: handlerCtx.reqId });
    // 最后一站：relay 超时路径不写响应，这里没有上层 failover，必须自己收尾
    if (out.timedOut) {
      json(res, 502, { error: out.detail?.upstreamError ? `upstream error: ${out.detail.upstreamError}` : `stream timed out after ${out.totalMs}ms` });
    }
    return true;
  }
  evt("result", { reqId: handlerCtx.reqId, model: lastErr?.model ?? requested, status: lastErr?.status ?? 502, via: "none", timing: null });
  evt("client-response", { requested, actual: lastErr?.model ?? requested, via: "none", fallback: false, status: lastErr?.status ?? 502, reqId: handlerCtx.reqId });
  json(res, 502, { error: lastErr?.message || "all auto models failed" });
  return true;
}
