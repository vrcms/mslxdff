import { relay, SLOW_TOTAL_MS, STREAM_TIMEOUT_MS, STALL_TIMEOUT_MS, SCORE_STALL_MS } from "../stream.js";
import { buildFallbackInfo } from "../fallback.js";
import { createRelayPipeline } from "./relay-pipeline.js";
import { racePeerCandidates } from "../peers.js";

/** 薄适配：peer 赛跑后经由 pipeline（via=peer） */
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
    upRes: win.res,
    body,
    requested,
    actual: win.target,
    lastErr,
    via: "peer",
    lockModel,
    useAuto,
    handlerCtx: { ...handlerCtx, model: win.target },
    mark,
    perf0,
    stages,
    startedAt,
  });
  return { handled: true };
}
