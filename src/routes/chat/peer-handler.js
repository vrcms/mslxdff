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
  deps = {},
}) {
  const { createPipeline = createRelayPipeline, racePeerCandidates: race = racePeerCandidates } = deps;
  evt("peer-race-start", { reqId: handlerCtx.reqId, model, peers: peers.ordered().length });
  const peerErrors = [];
  const pctx = { ...handlerCtx, peerErrors };
  const win =
    (await race(peers.ordered(), pctx)) ||
    (await race(peers.orderedByLastError(), pctx)) ||
    (await race(peers.coolingByLastError(), pctx));
  if (!win) {
    evt("peer-race-lose", { reqId: handlerCtx.reqId, model });
    // 组员全失败：把每个组员的真实返回汇总给调用者（否则只剩一个无信息的 429/502）
    const detail = peerErrors.length
      ? peerErrors.map((e) => `${e.peer} -> ${e.status}${e.message ? ` (${String(e.message).slice(0, 160)})` : ""}`).join("; ")
      : "no peers available";
    const allLimit = peerErrors.length > 0 && peerErrors.every((e) => e.status === 429);
    return { handled: false, lastErr: { model, upstream: null, status: allLimit ? 429 : 502, message: `peers failed: ${detail}` } };
  }
  evt("peer-race-win", { reqId: handlerCtx.reqId, model, winPeer: win.peer.url, winTarget: win.target, latencyMs: win.latencyMs });
  await peers.recordResult(win.peer.url, { ok: true, latencyMs: win.latencyMs, model: win.target });

  const pipeline = createPipeline({
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
  const r = await pipeline.execute({
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
  // Note: 超时/失败必须把 handled:false 交回上层换候选（丢弃 → 响应永不 end）— 见 .agents/notes/implemented/bug-fix/2026-09-17-relay-first-chunk-gate-real-cancel.md
  if (!r.handled) return { handled: false, upRes: null, lastErr: r.lastErr };
  return { handled: true };
}