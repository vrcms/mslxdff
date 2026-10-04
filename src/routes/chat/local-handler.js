import { relay, SLOW_TOTAL_MS, STREAM_TIMEOUT_MS, STALL_TIMEOUT_MS, SCORE_STALL_MS } from "../stream.js";
import { buildFallbackInfo } from "../fallback.js";
import { createRelayPipeline } from "./relay-pipeline.js";

/** 薄适配：本地透传唯一经由 relay-pipeline */
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
  attemptStartMs,
  stages,
  startedAt,
  plugins,
  res,
}) {
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
    upRes,
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
    attemptStartMs,
    stages,
    startedAt,
  });
  // wrotePayload 是「正文真到了下游」的送达证据：serial-trial 记 empty-turn-recovered 只认它，
  // 不认 handled 本身（handled 也覆盖下游已断开等零输出路径，见 ADR-0043）。
  if (!r.handled) return { handled: false, upRes: null, lastErr: r.lastErr };
  return { handled: true, wrotePayload: r.wrotePayload === true };
}
