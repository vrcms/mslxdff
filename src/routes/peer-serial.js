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
    perAttemptCap, deadline, budgetMs, probePeer,
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
  // 指定模型 5xx 场景只要 1 个节点：peerMaxPeers=1 时 IPv4 链截断、IPv6 阶段直接跳过。
  // 缺省 Infinity = 现有行为（整链 + v6 阶段）。
  const maxPeers = Number(ctx.peerMaxPeers) > 0 ? Math.floor(Number(ctx.peerMaxPeers)) : Infinity;
  const ipv4Chain = filterSlow(fresh(candidates)).slice(0, maxPeers);
  const ipv6Chain = Number.isFinite(maxPeers) ? [] : filterSlow(fresh(v6Candidates));

  // —— 预取 + 探针（用户 2026-10-20 口径）——
  // 「某个节点当备选的时候打一个 hi，准备轮到它了也打一个 hi；hi 都回不来就当它不行，直接换。」
  // 两个 hi 都打，不做结果复用：备选是上一次切换时定的，中间可能已过了几十秒
  // （上一个节点在大 body 上撞墙，实测 1.5MB 要 28~62s），那时活不代表现在活。
  // 备选那个 hi 的作用是暖连接 + 提前暴露死节点，轮到时的那个才决定去留。
  let pending = null;
  // resolvePeerTarget 会打 /v1/models/status，别为探针白测两次：这里记住解析结果给下一轮复用。
  const resolved = new Map(); // url -> Promise<{peer,target}|null>
  const resolveOnce = (peer) => {
    const hit = resolved.get(peer.url);
    if (hit) return hit;
    const p = Promise.resolve()
      .then(() => resolvePeerTarget(ctx, peer))
      .catch(() => null);
    resolved.set(peer.url, p);
    return p;
  };
  const prime = (peer, target) => {
    if (!peer || !target || typeof probePeer !== "function") return;
    try {
      const p = probePeer(peer, target);
      if (p && typeof p.then === "function") p.catch(() => {});
    } catch { /* 预热失败不影响主流程 */ }
  };
  const primeAt = (peer) => {
    if (!peer) return;
    resolveOnce(peer)
      .then((r) => { if (r) prime(r.peer, r.target); })
      .catch(() => {});
  };
  const takeNext = (stage) => {
    const chain = stage === "ipv6" ? ipv6Chain : ipv4Chain;
    const p = chain.shift() || null;
    // 立刻给「再下一个」打 hi。模型名要现在解析——下一轮循环该它时 ctx.model 可能已变。
    if (p) primeAt(chain[0] || null);
    return p;
  };

  let stage = "ipv4";
  let emptyIpv4Announced = false;

  // 链头从没当过「备选」（它一上来就是主角），进入循环前先给它也打一个 hi ——
  // 此时 ctx.model 还是本机刚失败的那个模型，解析目标与后面轮到时同源。
  primeAt(ipv4Chain[0] || null);

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

    const prepared = await resolveOnce(pending);
    if (!prepared) continue;
    const { peer, target } = prepared;
    tried.add(peer.url);
    const ctrl = new AbortController();
    const name = peerName(peer);

    // 轮到它了：再打一个 hi。回不来就当这个备选不行，直接换下一个。
    if (typeof probePeer === "function") {
      const t = performance.now();
      let r;
      try { r = await probePeer(peer, target); } catch { r = { ok: false }; }
      const probeMs = Math.round(performance.now() - t);
      if (r && r.ok === false) {
        ctx.evt("peer-probe", { peer: peer.url, name, model: target, phase: "turn", ok: false, status: r.status ?? null, latencyMs: probeMs, action: "skip" });
        failed.push({ ok: false, peer, target, res: null, status: r.status || 502 });
        recordLater(() => ctx.peers.recordError(peer.url, { status: r.status || 502 }));
        recordLater(() => ctx.peers.recordResult(peer.url, { ok: false }));
        continue;
      }
      ctx.evt("peer-probe", { peer: peer.url, name, model: target, phase: "turn", ok: true, status: r?.status ?? null, latencyMs: probeMs });
      if (deadline > 0 && Date.now() >= deadline) {
        ctx.evt("peer-budget-out", { peer: null, reason: `peer 阶段总预算 ${budgetMs}ms 用尽（探针后）`, budgetMs, remaining: ipv4Chain.length + ipv6Chain.length });
        break;
      }
    }

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
