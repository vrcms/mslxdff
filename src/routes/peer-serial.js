// 组员串行选路（用户 2026-10-19 决定：不竞速；2026-10-20 升级为**常驻热备**）。
//
// 两种模式下都必须满足的语义：
//   「本机额度用完 → 用延迟最小的组员」，但**组长恒定第一**（先榨干组长额度），
//   组长也满了才按延迟升序逐个组员顶上。
//
// 2026-10-20 用户要求「永远准备一个备选，429 立即切」：
//   ① 进循环前就**预取**下一个候选（不是每次现排序）；
//   ② 切换成功后**立即再预取**下一个；
//   ③ 对预取的备选做**连接预热**（轻量 /health 建连），切过去时连接已在池里，省掉建连 RTT。
//
// IPv4 全用完 → 进 IPv6 阶段：先组长 v6，再按延迟升序找 hasV6 的组员。
//
// 本模块只做「按序试 + 预取」这件事，其余（画目标、转发、记账、事件名）从 peers.js 注入，避免循环依赖。
export const PEER_SERIAL = true;

/**
 * 连接预热：对备选节点发一个极轻的请求，只为让 undici 连接池里提前建好 TCP/TLS 连接。
 * 失败静默——预热只是提速，不是前置条件；真发请求时该失败还是会失败。
 * @param {object} peer  目标 peer（需 url）
 * @param {object} deps  { warmFetch?, timeoutMs? }
 */
export function warmPeer(peer, deps = {}) {
  const { warmFetch, timeoutMs = 1500 } = deps;
  if (!peer?.url || typeof warmFetch !== "function") return Promise.resolve();
  try {
    const p = warmFetch(`${peer.url}/health`, { method: "GET", timeoutMs });
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch { /* 预热失败不影响主流程 */ }
  return Promise.resolve();
}

/**
 * 串行试候选（预取 + 预热版）：一次只打一个，成功即返回；失败顺位试下一个。
 *
 * @param {object} p
 * @param {Array}  p.candidates        已排好序的组员（组长第一、其余延迟升序）
 * @param {Array}  [p.v6Candidates]    IPv4 全用完后的 v6 阶段候选（同样已排序）
 * @param {object} p.ctx               请求上下文（evt/peers/body/hops/plugins/peerErrors/triedUrls…）
 * @param {Set}    p.tried             已试过的 url 集合
 * @param {object} p.deps              { resolvePeerTarget, forwardToPeer, warmPeer, peerName, recordLater,
 *                                       summarizeRequest, runHook, errMsg, perAttemptCap, deadline, budgetMs }
 * @returns {Promise<null | {peer, target, res, latencyMs}>}
 */
export async function serialTryPeers({ candidates, v6Candidates = [], ctx, tried, deps }) {
  const {
    resolvePeerTarget, forwardToPeer, peerName, recordLater, summarizeRequest, runHook, errMsg,
    perAttemptCap, deadline, budgetMs,
  } = deps;
  const warm = deps.warmPeer || warmPeer;
  const failed = [];

  // 延迟上限过滤：历史延迟超过「单次尝试上限」的组员直接跳过（它大概率又超时）。
  // 只在**还有别的候选**时才跳过，避免把唯一可用的节点也跳没了。
  const filterSlow = (list) => list.filter((p) => {
    let lat = null;
    try {
      // 与 ordered() 同源：先看真实请求 EMA，再回落到心跳上报的 rtt
      lat = ctx.peers?.stat?.(p.url)?.latencyMs ?? p.heartbeatLatencyMs ?? null;
      if (lat != null) lat = Number(lat);
    } catch { lat = null; }
    if (lat == null || !Number.isFinite(lat) || lat <= perAttemptCap) return true;
    if (list.length <= 1) return true; // 只剩它 → 仍然试
    ctx.evt("peer-skip-slow", { peer: p.url, name: peerName(p), latencyMs: lat, capMs: perAttemptCap });
    return false;
  });

  // 两段链：先 IPv4（组长→组员延迟升序），IPv4 全败才进 IPv6（同样组长优先 + hasV6 过滤）。
  // 只保留本次还没试过的。
  const fresh = (list) => list.filter((p) => !tried.has(p.url));
  const ipv4Chain = filterSlow(fresh(candidates));
  const ipv6Chain = filterSlow(fresh(v6Candidates));

  // —— 预取：进循环前就把「下一个」定好，并顺手预热连接 ——
  let pending = null;
  const prime = (peer) => {
    if (!peer) return;
    warm(peer, deps.warmPeerDeps);
  };
  const takeNext = (stage) => {
    const chain = stage === "ipv6" ? ipv6Chain : ipv4Chain;
    const p = chain.shift() || null;
    if (p) prime(chain[0] || null); // 立即预热「再下一个」，保证永远有备选就绪
    return p;
  };

  let stage = "ipv4";
  let emptyIpv4Announced = false;

  for (;;) {
    if (deadline > 0 && Date.now() >= deadline) {
      const remaining = ipv4Chain.length + ipv6Chain.length;
      ctx.evt("peer-budget-out", { peer: null, reason: `peer 阶段总预算 ${budgetMs}ms 用尽`, budgetMs, remaining });
      break;
    }
    pending = takeNext(stage);
    // IPv4 链走空 → 切 IPv6 阶段（用户约定：所有正常 IPv4 额度用完才动 v6）
    if (!pending && stage === "ipv4") {
      stage = "ipv6";
      if (!ipv6Chain.length) {
        if (!emptyIpv4Announced) {
          emptyIpv4Announced = true;
          ctx.evt("peer-v6-stage", { entered: false, reason: ipv4Chain.length ? "ipv4 未走空" : "无 hasV6 候选" });
        }
        break;
      }
      ctx.evt("peer-v6-stage", { entered: true, candidates: ipv6Chain.length });
      pending = takeNext("ipv6");
      if (!pending) break;
    }
    if (!pending) break;

    const prepared = await resolvePeerTarget(ctx, pending);
    if (!prepared) continue;
    const { peer, target } = prepared;
    tried.add(peer.url);
    const ctrl = new AbortController();
    const name = peerName(peer);
    ctx.evt("peer-request", { peer: peer.url, name, model: target, hops: ctx.hops + 1, payload: summarizeRequest(ctx.body), serial: 1, stage });
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
      ctx.evt("peer-attempt", { peer: peer.url, name, model: target, hops: ctx.hops + 1, latencyMs, ok: false, status, message: msg, stage });
      ctx.evt("peer-error", { peer: peer.url, name, model: target, status, message: msg });
      failed.push({ ok: false, peer, target, res, status });
      recordLater(() => ctx.peers.recordError(peer.url, { status, message: msg }));
      recordLater(() => ctx.peers.recordResult(peer.url, { ok: false }));
      continue; // 串行：试下一个（预取的下一个已经在路上）
    }
    ctx.evt("peer-forward", { peer: peer.url, name, model: target, hops: ctx.hops + 1, latencyMs, ok: true, status, stage });
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
