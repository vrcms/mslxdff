// 组员串行选路（用户 2026-10-19 决定：不竞速）。
//
// 为什么改：并发赛跑会同时占用多个组员的额度/连接，慢节点还会拖住整批；而用户要的语义是
// 「本机额度用完 → 用延迟最小的组员」，延迟小的先上、不行再下一个。串行让这条优先级真正生效。
//
// 本模块只做「按序试」这件事，其余（画目标、转发、记账、事件名）从 peers.js 注入，避免循环依赖。
export const PEER_SERIAL = true;

/**
 * 串行试候选：一次只打一个，成功即返回；失败顺位试下一个。
 *
 * @param {object} p
 * @param {Array}  p.candidates        已按「延迟最小优先」排好的组员
 * @param {object} p.ctx               请求上下文（evt/peers/body/hops/plugins/peerErrors/triedUrls…）
 * @param {Set}    p.tried             已试过的 url 集合
 * @param {object} p.deps              { resolvePeerTarget, forwardToPeer, peerName, recordLater,
 *                                       summarizeRequest, runHook, errMsg, perAttemptCap, deadline, budgetMs }
 * @returns {Promise<null | {peer, target, res, latencyMs}>}
 */
export async function serialTryPeers({ candidates, ctx, tried, deps }) {
  const {
    resolvePeerTarget, forwardToPeer, peerName, recordLater, summarizeRequest, runHook, errMsg,
    perAttemptCap, deadline, budgetMs,
  } = deps;
  const failed = [];
  // 延迟上限过滤：历史延迟超过「单次尝试上限」的组员直接跳过（它大概率又超时）。
  // 只在**还有别的候选**时才跳过，避免把唯一可用的节点也跳没了。
  const ranked = candidates.filter((p) => {
    let lat = null;
    try {
      // 与 ordered() 同源：先看真实请求 EMA，再回落到心跳上报的 rtt
      lat = ctx.peers?.stat?.(p.url)?.latencyMs ?? p.heartbeatLatencyMs ?? null;
      if (lat != null) lat = Number(lat);
    } catch { lat = null; }
    if (lat == null || !Number.isFinite(lat) || lat <= perAttemptCap) return true;
    if (candidates.length <= 1) return true; // 只剩它 → 仍然试
    ctx.evt("peer-skip-slow", { peer: p.url, name: peerName(p), latencyMs: lat, capMs: perAttemptCap });
    return false;
  });

  for (let i = 0; i < ranked.length; i++) {
    if (deadline > 0 && Date.now() >= deadline) {
      ctx.evt("peer-budget-out", { peer: null, reason: `peer 阶段总预算 ${budgetMs}ms 用尽`, budgetMs, remaining: ranked.length - i });
      break;
    }
    const prepared = await resolvePeerTarget(ctx, ranked[i]);
    if (!prepared) continue;
    const { peer, target } = prepared;
    tried.add(peer.url);
    const ctrl = new AbortController();
    const name = peerName(peer);
    ctx.evt("peer-request", { peer: peer.url, name, model: target, hops: ctx.hops + 1, payload: summarizeRequest(ctx.body), serial: i + 1 });
    if (ctx.plugins?.length) {
      runHook(ctx.plugins, "peer:beforeForward", { reqId: ctx.reqId, peer: peer.url, model: target, hops: ctx.hops + 1 }).catch(() => {});
    }
    const remainingMs = deadline > 0 ? deadline - Date.now() : 0;
    // 单个组员的等待上限 = min(阶段剩余预算, 单次尝试上限)。单次上限保证黑洞节点
    // 不会吃掉整个阶段（否则延迟最小的好组员轮不到）。
    const waitMs = deadline > 0 ? Math.max(1, Math.min(perAttemptCap, remainingMs)) : perAttemptCap;
    const t0 = performance.now();
    const res = await forwardToPeer(peer, ctx.body, target, ctx.hops, ctrl, waitMs);
    const latencyMs = Math.round(performance.now() - t0);
    const isErr = res instanceof Error;
    const status = isErr ? 502 : res.status;
    if (ctx.plugins?.length) {
      runHook(ctx.plugins, "peer:result", { reqId: ctx.reqId, peer: peer.url, model: target, ok: !(isErr || status >= 400), status, latencyMs }).catch(() => {});
    }
    if (isErr || status >= 400) {
      const msg = isErr ? errMsg(res).slice(0, 200) : null;
      if (Array.isArray(ctx.peerErrors)) ctx.peerErrors.push({ peer: peer.url, status, message: msg });
      ctx.evt("peer-attempt", { peer: peer.url, name, model: target, hops: ctx.hops + 1, latencyMs, ok: false, status, message: msg });
      ctx.evt("peer-error", { peer: peer.url, name, model: target, status, message: msg });
      failed.push({ ok: false, peer, target, res, status });
      recordLater(() => ctx.peers.recordError(peer.url, { status, message: msg }));
      recordLater(() => ctx.peers.recordResult(peer.url, { ok: false }));
      continue; // 串行：试下一个
    }
    ctx.evt("peer-forward", { peer: peer.url, name, model: target, hops: ctx.hops + 1, latencyMs, ok: true, status });
    return { peer, target, res, latencyMs };
  }

  // 全败：补读失败响应体（诊断 + 调用者详情）
  await Promise.all(failed.map(async (o) => {
    if (!o.res || typeof o.res !== "object" || o.res instanceof Error) return;
    try {
      const snip = String(await Promise.race([
        o.res.clone().text(),
        new Promise((r) => { const t = setTimeout(() => r(""), 600); t.unref?.(); }),
      ])).replace(/\s+/g, " ").slice(0, 300);
      if (!snip) return;
      if (Array.isArray(ctx.peerErrors)) {
        const rec = ctx.peerErrors.find((x) => x.peer === o.peer.url && x.status === o.status && !x.message);
        if (rec) rec.message = snip;
      }
      ctx.evt("peer-error", { peer: o.peer.url, name: peerName(o.peer), model: o.target, status: o.status, message: `body=${snip}` });
    } catch {}
  }));
  return null;
}
