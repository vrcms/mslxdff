import { buildFallbackInfo } from "../fallback.js";
import { relay, SLOW_TOTAL_MS } from "../stream.js";
import { tryBroadbandRelay } from "../relay-queue.js";
import { runHook } from "../../plugins.js";

export async function handleBroadbandRelay({
  model,
  body,
  hops,
  lastErr,
  requested,
  useAuto,
  lockModel,
  auto,
  groups,
  token,
  bus,
  logs,
  handlerCtx,
  evt,
  mark,
  perf0,
  stages,
  res,
  startedAt,
  plugins,
}) {
  const bb = await tryBroadbandRelay({ groups, token, model, body, hops, bus, logs, reqId: handlerCtx.reqId, evt, res, mark, perf0, stages });
  if (!bb) {
    evt("relay-miss", { reqId: handlerCtx.reqId, model });
    return { handled: false };
  }
  const isResponse = bb.result && typeof bb.result.status === "number" && typeof bb.result.headers?.get === "function";
  if (isResponse) {
    const bbFallback = buildFallbackInfo({ requested, actual: model, lastErr, via: "broadband", useAuto, lockModel });
    if (bbFallback?.fallback) evt("fallback-notice", { reqId: handlerCtx.reqId, requested, actual: model, reason: bbFallback.reason, notice: bbFallback.notice, via: "broadband" });
    evt("relay-start", { reqId: handlerCtx.reqId, model, via: "broadband", target: bb.target, group: bb.group, fallback: bbFallback });
    const out = await relay(res, bb.result, body, {
      fallback: bbFallback,
      onFirstChunk: (d) => mark(`ttf-bb-${model}`),
      onDownstreamAbort: () => evt("client-abort", { reqId: handlerCtx.reqId, model, totalMs: Math.round(Date.now() - startedAt), stages: [...stages] }),
    });
    evt("relay-done", { reqId: handlerCtx.reqId, model, via: "broadband", status: out.status, ttfMs: out.ttfMs, totalMs: out.totalMs, aborted: out.aborted, interrupted: out.interrupted ?? false, detail: out.detail ?? null });
    if (auto && out.status === 200) {
      const latencyMs = out.totalMs ?? 0;
      if (out.detail?.stallHits > 0 || (latencyMs && latencyMs > SLOW_TOTAL_MS)) {
        void auto.recordError(model, { status: 200, slow: true, note: `broadband slow ${latencyMs}ms` });
        void auto.recordLatency(model, latencyMs);
      } else {
        await auto.recordOk(model, { latencyMs });
      }
    }
    evt("result", { model, status: out.status, via: "broadband", timing: bb.result._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, detail: out.detail ?? null, fallback: bbFallback, requested, actual: model });
    evt("client-response", { requested, actual: model, via: "broadband", fallback: bbFallback, status: out.status, reqId: handlerCtx.reqId });
    if (plugins?.length) runHook(plugins, "request:completed", { reqId: handlerCtx.reqId, requested, useAuto, hops: handlerCtx.hops, stream: Boolean(body.stream), durationMs: Date.now() - startedAt, via: "broadband", status: out.status, actual: model, fallback: bbFallback }).catch(() => {});
    return { handled: true };
  } else if (bb.result && typeof bb.result.status === "number") {
    const fakeRes = {
      status: bb.result.status,
      headers: { get: (k) => bb.result.headers?.[k] || bb.result.headers?.[k.toLowerCase()] || null },
      text: async () => typeof bb.result.body === "string" ? bb.result.body : JSON.stringify(bb.result.body),
      body: (() => {
        const b = bb.result.body || "";
        const str = typeof b === "string" ? b : JSON.stringify(b);
        const isSSE = bb.result.headers?.["Content-Type"]?.includes("text/event-stream");
        if (isSSE) {
          return (async function* () { yield Buffer.from(str); })();
        }
        return null;
      })(),
    };
    const bbLocalFallback = buildFallbackInfo({ requested, actual: model, lastErr, via: "broadband", useAuto, lockModel });
    if (bbLocalFallback?.fallback) evt("fallback-notice", { reqId: handlerCtx.reqId, requested, actual: model, reason: bbLocalFallback.reason, notice: bbLocalFallback.notice, via: "broadband" });
    evt("relay-start", { reqId: handlerCtx.reqId, model, via: "broadband-local", target: bb.target, group: bb.group, fallback: bbLocalFallback });
    const out = await relay(res, fakeRes, body, {
      fallback: bbLocalFallback,
      onFirstChunk: (d) => mark(`ttf-bb-${model}`),
      onDownstreamAbort: () => evt("client-abort", { reqId: handlerCtx.reqId, model, totalMs: Math.round(Date.now() - startedAt), stages: [...stages] }),
    });
    evt("relay-done", { reqId: handlerCtx.reqId, model, via: "broadband-local", status: out.status, ttfMs: out.ttfMs, totalMs: out.totalMs, aborted: out.aborted, interrupted: out.interrupted ?? false, detail: out.detail ?? null });
    evt("result", { model, status: out.status, via: "broadband", timing: null, ttfMs: out.ttfMs, totalMs: out.totalMs, detail: out.detail ?? null, fallback: bbLocalFallback, requested, actual: model });
    evt("client-response", { requested, actual: model, via: "broadband", fallback: bbLocalFallback, status: out.status, reqId: handlerCtx.reqId });
    if (plugins?.length) runHook(plugins, "request:completed", { reqId: handlerCtx.reqId, requested, useAuto, hops: handlerCtx.hops, stream: Boolean(body.stream), durationMs: Date.now() - startedAt, via: "broadband", status: out.status, actual: model, fallback: bbLocalFallback }).catch(() => {});
    return { handled: true };
  }
  evt("relay-miss", { reqId: handlerCtx.reqId, model });
  return { handled: false };
}
