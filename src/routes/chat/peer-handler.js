import { relay, SLOW_TOTAL_MS, STREAM_TIMEOUT_MS, STALL_TIMEOUT_MS, SCORE_STALL_MS } from "../stream.js";
import { buildFallbackInfo } from "../fallback.js";
import { createRelayPipeline } from "./relay-pipeline.js";
import { racePeerCandidates, peerStageCtx } from "../peers.js";

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
  attemptStartMs,
  stages,
  startedAt,
  plugins,
  res,
  deps = {},
}) {
  const { createPipeline = createRelayPipeline, racePeerCandidates: race = racePeerCandidates } = deps;
  evt("peer-race-start", { reqId: handlerCtx.reqId, model, peers: peers.ordered().length });
  const peerErrors = [];
  // 三批共享同一 peer 阶段总预算（同 hedge：旧行为是每批各吃满一次等头超时，串行叠加到 90s+）
  const pctx = peerStageCtx({ ...handlerCtx, peerErrors });
  // singlePeer：指定模型 5xx 重试耗尽后只换 1 个节点，该节点仍失败就交回上层收场。
  // 选人仍按「组长第一 → 延迟升序」，只是取链头一个；三批候选不叠加，也不进 IPv6 阶段。
  const singlePeer = handlerCtx?.singlePeer === true;
  let win = null;
  if (singlePeer) {
    pctx.peerMaxPeers = 1;
    const pick = peers.ordered()[0] || peers.orderedByLastError?.()?.[0] || peers.coolingByLastError?.()?.[0] || null;
    win = pick ? await race([pick], pctx) : null;
  } else {
    win =
      (await race(peers.ordered(), pctx)) ||
      (await race(peers.orderedByLastError(), pctx)) ||
      (await race(peers.coolingByLastError(), pctx));
  }
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
  // 这里只拿到**响应头**，pipeline 后面还可能超时/空轮。故先记 provisional（只暖热缓存、参与选路），
  // 真正的成功计数等 pipeline 报 handled:true 再记——否则"收到 200 但零正文"也被算成转发成功。
  await peers.recordResult(win.peer.url, { ok: true, latencyMs: win.latencyMs, model: win.target, provisional: true });

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
    attemptStartMs,
    stages,
    startedAt,
  });
  // Note: 超时/失败必须把 handled:false 交回上层换候选（丢弃 → 响应永不 end）— 见 .agents/notes/implemented/bug-fix/2026-09-17-relay-first-chunk-gate-real-cancel.md
  if (!r.handled) return { handled: false, upRes: null, lastErr: r.lastErr };
  // 真正送达才算这个节点成功转发一次（口径见 peers.js 的 bumpWins 注释）
  await peers.recordResult(win.peer.url, { ok: true, latencyMs: win.latencyMs, model: win.target });
  return { handled: true };
}