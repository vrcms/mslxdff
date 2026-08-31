import { relay, SLOW_TOTAL_MS, STREAM_TIMEOUT_MS, STALL_TIMEOUT_MS, SCORE_STALL_MS } from "../stream.js";
import { buildFallbackInfo } from "../fallback.js";
import { createRelayPipeline } from "./relay-pipeline.js";
import { tryBroadbandRelay } from "../relay-queue.js";

/** 薄适配：broadband 两种形态合一经由 pipeline */
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
  const pipeline = createRelayPipeline({
    relay,
    buildFallbackInfo,
    auto,
    plugins,
    evt,
    mark,
    logCall: () => {},
    logError: () => {},
    constants: { STREAM_TIMEOUT_MS, SLOW_TOTAL_MS, STALL_TIMEOUT_MS, SCORE_STALL_MS },
    startedAt,
    stages,
  });
  const isResponse = bb.result && typeof bb.result.status === "number" && typeof bb.result.headers?.get === "function";
  if (isResponse) {
    await pipeline.execute({ res, upRes: bb.result, body, requested, actual: model, lastErr, via: "broadband", lockModel, useAuto, handlerCtx, mark, perf0, stages, startedAt });
    return { handled: true };
  }
  if (bb.result && typeof bb.result.status === "number") {
    const b = bb.result.body || "";
    const str = typeof b === "string" ? b : JSON.stringify(b);
    const isSSE = bb.result.headers?.["Content-Type"]?.includes("text/event-stream");
    const fakeRes = {
      status: bb.result.status,
      headers: { get: (k) => bb.result.headers?.[k] || bb.result.headers?.[k.toLowerCase()] || null },
      text: async () => str,
      body: isSSE ? (async function* () { yield Buffer.from(str); })() : null,
    };
    await pipeline.execute({ res, upRes: fakeRes, body, requested, actual: model, lastErr, via: "broadband-local", lockModel, useAuto, handlerCtx, mark, perf0, stages, startedAt });
    return { handled: true };
  }
  evt("relay-miss", { reqId: handlerCtx.reqId, model });
  return { handled: false };
}
