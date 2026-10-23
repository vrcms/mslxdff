import { loadPeers, savePeers, loadPeerErrors, savePeerErrors, loadPeerStats, savePeerStats } from "./state.js";

// 组员失败冷却分级（2026-10-18 用户拍板）：
// 非额度失败（502/5xx/超时，可能几秒就恢复）→ 短冷却 10s，到点自动重新纳入候选、继续挨个重试；
// 额度类（连续 2 次 429）→ 长冷却 10min（额度当天不会因快重试恢复，反复撞只会白烧配额）。
export const DEFAULT_PEER_COOLDOWN_MS = 10_000;
export const DEFAULT_PEER_LIMIT_COOLDOWN_MS = 10 * 60_000;
export const DEFAULT_PEER_HEAT_MS = 5 * 60_000;
export const DEFAULT_MAX_HOPS = 3;
export const DEFAULT_BROADBAND_STALE_MS = 90_000;
// 连续几次连接级失败即视为"这个地址没服务"，进长冷却（不再靠 30s 短冷却反复捞回）。
export const DEAD_FAIL_THRESHOLD = 2;
// 探测失败（GET /health 连不上）视为"这个节点当前不可用"，10 分钟内不再当候选。
// 与请求失败账分开：health 探测是**主动、零额度**的可用性判断，比"这一发不顺"更可信——
// 现网 2026-10-20 13:27 req mvg8r7cz-b8qn：152.67.222.233:62028 早已 health timeout，
// CLI/保热都探到了，但选路不知道，仍把它排进候选并吃满 20s 单次上限（总 27s）。
export const DEFAULT_PEER_PROBE_DEAD_MS = 10 * 60_000;

export function peerProbeDeadMs() {
  const n = Number(process.env.MSLXDFF_PEER_PROBE_DEAD_MS);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_PEER_PROBE_DEAD_MS;
}

const EMA_ALPHA = 0.3;

export function broadbandStaleMs() {
  const n = Number(process.env.MSLXDFF_BROADBAND_STALE_MS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_BROADBAND_STALE_MS;
}

export function isBroadbandStale(peer, nowMs = Date.now(), staleMs = broadbandStaleMs()) {
  const kind = peer?.kind || (String(peer?.url || "").startsWith("relay://") ? "broadband" : "static");
  if (kind !== "broadband") return false;
  const lastSeen = peer?.lastSeen;
  if (typeof lastSeen !== "number") return true; // no heartbeat yet => stale
  return nowMs - lastSeen > staleMs;
}

export function normalizePeerUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

export function createPeersService({
  file,
  now = () => Date.now(),
  cooldownMs = DEFAULT_PEER_COOLDOWN_MS,
  limitCooldownMs = DEFAULT_PEER_LIMIT_COOLDOWN_MS,
  heatMs = DEFAULT_PEER_HEAT_MS,
  peers: seedPeers,
  errors: seedErrors,
  stats: seedStats,
  persistPeers = (list, f = file) => savePeers(list, f ? { file: f } : {}),
  persistErrors = (errors, f = file) => savePeerErrors(errors, f ? { file: f } : {}),
  persistStats = (stats, f = file) => savePeerStats(stats, f ? { file: f } : {}),
} = {}) {
  const list = (seedPeers ?? loadPeers(file ? { file } : {}))
    .map((p) => ({ ...p, url: normalizePeerUrl(p.url) }))
    .filter((p) => p && p.url);
  const lastErrorAt = { ...(seedErrors ?? loadPeerErrors(file ? { file } : {})) };
  const stats = { ...(seedStats ?? loadPeerStats(file ? { file } : {})) };

  function all() {
    return [...list];
  }

  function add(peer) {
    const url = normalizePeerUrl(peer?.url);
    if (!url) return false;
    const existing = list.find((p) => p.url === url);
    const entry = { ...peer, url };
    if (existing) Object.assign(existing, entry);
    else list.push(entry);
    persistPeers([...list]);
    return true;
  }

  function remove(url) {
    const target = normalizePeerUrl(url);
    const idx = list.findIndex((p) => p.url === target);
    if (idx < 0) return false;
    list.splice(idx, 1);
    persistPeers([...list]);
    return true;
  }

  function removeByGroup(group) {
    const before = list.length;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].group === group) list.splice(i, 1);
    }
    if (list.length !== before) persistPeers([...list]);
    return before - list.length;
  }

  // 分级冷却：连续 429（streak >= 2）→ limitCooldownMs（限流恢复慢，5min 内不再考虑）；
  // 连接级永久失败（ECONNREFUSED/ENOTFOUND，deadFails >= 2）同样进长冷却；
  // 其他失败（网络抖动、5xx）→ cooldownMs（可能几秒恢复，给快速重试机会）。
  function coolingWindowMs(url) {
    // 探测死亡（health 连不上）：10min 内不再考虑——比请求失败更可信的"没服务"证据
    if (stats[url]?.probeDeadAt !== undefined && now() - stats[url].probeDeadAt < peerProbeDeadMs()) return limitCooldownMs;
    if ((stats[url]?.deadFails ?? 0) >= DEAD_FAIL_THRESHOLD) return limitCooldownMs;
    const streak = stats[url]?.streak429 ?? 0;
    return streak >= 2 ? limitCooldownMs : cooldownMs;
  }

  // 连接级失败（端口没服务/DNS 解析不了）与"这一发不顺"是两回事：前者换多少次都一样，
  // 现网 node-b（127.0.0.1:3500，本机根本没服务）靠 30s 短冷却 + 兜底，被反复竞速 1569 次。
  function isConnLevelFailure(message) {
    const s = String(message || "");
    return /ECONNREFUSED|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ECONNRESET|fetch failed|connect (?:timeout|ETIMEDOUT)|socket hang up/i.test(s);
  }

  function isCooling(url) {
    // 探测死亡（health 探不通）：10min 内不再当候选——比请求失败更可信的"没服务"证据
    const pDead = stats[url]?.probeDeadAt;
    if (pDead !== undefined && now() - pDead < peerProbeDeadMs()) return true;
    const win = coolingWindowMs(url);
    if (!win) return false;
    const err = lastErrorAt[url];
    if (typeof err === "number" && now() - err < win) return true;
    const peer = list.find((p) => p.url === url);
    if (peer && isBroadbandStale(peer, now(), broadbandStaleMs())) return true;
    return false;
  }

  function isBroadbandCooling(url) {
    const peer = list.find((p) => p.url === url);
    if (!peer) return false;
    return isBroadbandStale(peer, now(), broadbandStaleMs());
  }

  function available() {
    return list.filter((p) => !isCooling(p.url));
  }

  // A peer counts as "hot" when it succeeded recently: reuse its last model
  // without a fresh health probe to keep the fast path fast.
  function isHot(url, t = now()) {
    if (isCooling(url)) return false;
    const s = stats[url];
    return Boolean(s?.okAt) && t - s.okAt < heatMs;
  }

  function stat(url) {
    return stats[url] ? { ...stats[url] } : null;
  }

  function rankScore(p, t) {
    const s = stats[p.url];
    const hot = s?.okAt && t - s.okAt < heatMs ? 0 : 1;
    const latency = s?.latencyMs != null ? s.latencyMs : 1_000_000;
    const fails = s?.fails ?? 0;
    return hot * 1_000_000_000 + latency * 1_000 + fails;
  }

  // 可用组员排序（用户 2026-10-19 决定）：**延迟最小优先**，不再「热优先」。
  // 语义 = 「组员的额度用完后，用跟组长延迟最小的组员」——延迟是首要判据。
  // 延迟来源（优先级从高到低）：
  //   ① stats 里的真实请求 EMA（recordResult 记的 latencyMs）——最可信；
  //   ② peer.heartbeatLatencyMs —— 组员**定时心跳**上报的 rtt（没跑过真实请求时也能排序）；
  // 未测过延迟的排在有数据之后；同延迟按「最早失败优先」；都没失败过的排最后。
  // 组长识别：本机是组员时，peers 里有 name==="leader" 的记录（cli/group-test.js 同口径）。
  // 组长自己节点视角没有这条记录 → isLeaderPeer 恒 false，退化为纯延迟排序（正是想要的行为）。
  function isLeaderPeer(p) {
    return String(p?.name || "").toLowerCase() === "leader";
  }

  function peerLatency(p) {
    const s = stats[p.url]?.latencyMs;
    if (s != null) return s;
    const hb = list.find((x) => x.url === p.url)?.heartbeatLatencyMs;
    return Number.isFinite(Number(hb)) ? Number(hb) : null;
  }

  // 组员延迟升序（组长不参与），供两处复用：ordered 的第二档 + standbyChain。
  function byLatencyAsc(a, b) {
    const la = peerLatency(a);
    const lb = peerLatency(b);
    const ha = la != null, hb = lb != null;
    if (ha !== hb) return ha ? -1 : 1;          // 有延迟数据的优先
    if (ha && hb && la !== lb) return la - lb;  // 延迟小的先上
    const ea = lastErrorAt[a.url];
    const eb = lastErrorAt[b.url];
    if (ea == null && eb == null) return 0;
    if (ea == null) return 1;
    if (eb == null) return -1;
    return ea - eb;
  }

  // 用户 2026-10-20 约定：**组长恒定第一**（先榨干组长额度），组长用完再按延迟升序上组员。
  // 之前是纯延迟排序，「9/9 走组长」只是组长恰好延迟最低的巧合（AGENTS.md 已记差距）。
  function ordered(t = now()) {
    return available().sort((a, b) => {
      const la = isLeaderPeer(a), lb = isLeaderPeer(b);
      if (la !== lb) return la ? -1 : 1; // 组长恒排第一
      return byLatencyAsc(a, b);
    });
  }

  /**
   * 常驻接力链（用户 2026-10-20：永远准备一个备选，429 立即切）。
   * IPv4 阶段：组长 → 组员(延迟升序)；IPv4 全用完才进 IPv6 阶段：先本机/组长 v6，
   * 再按延迟升序找 hasV6 的组员。
   * @returns {{ipv4: object[], ipv6: object[]}} 两段链，各自已排序
   */
  function standbyChain(t = now()) {
    const ipv4 = available().sort((a, b) => {
      const la = isLeaderPeer(a), lb = isLeaderPeer(b);
      if (la !== lb) return la ? -1 : 1;
      return byLatencyAsc(a, b);
    });
    // IPv6 阶段：只保留心跳自报 hasV6 的节点，同样组长优先、其余延迟升序
    const ipv6 = ipv4.filter((p) => p.hasV6 === true);
    return { ipv4, ipv6 };
  }

  /** 下一个备选：从链里取第一个还没试过的。这就是「永远准备好的那个」。 */
  function nextStandby(tried, t = now()) {
    const { ipv4, ipv6 } = standbyChain(t);
    const skip = tried instanceof Set ? tried : new Set(tried || []);
    return {
      ipv4: ipv4.find((p) => !skip.has(p.url)) || null,
      ipv6: ipv6.find((p) => !skip.has(p.url)) || null,
    };
  }

  // Available peers ordered specifically for recovery-time retry: earliest
  // failure first (it has had the longest to come back), never-failed last.
  function orderedByLastError(t = now()) {
    return available().sort((a, b) => {
      const ea = lastErrorAt[a.url];
      const eb = lastErrorAt[b.url];
      if (ea == null && eb == null) return 0;
      if (ea == null) return 1; // never-failed peers go after any that failed
      if (eb == null) return -1;
      return ea - eb; // earliest failure first
    });
  }

  let cursor = 0;

  // 兜底重试集合：仅"因错误冷却中"的 peer（按最早失败优先）。
  // 场景：唯一可用节点偶发失败被冷却锁死 → 主链零候选/全败时，兜底给它一次机会；
  // 成功会被 recordResult 清除错误记录、回归热路径，避免"明明能用的节点被 30s 冷却全灭"。
  function coolingByLastError() {
    const t = now();
    return list
      .filter((p) => {
        const err = lastErrorAt[p.url];
        if (typeof err !== "number") return false;
        if (stats[p.url]?.probeDeadAt !== undefined && now() - stats[p.url].probeDeadAt < peerProbeDeadMs()) return false; // 探测死亡：兜底也不考虑（否则每次白等一次拒连）
        if ((stats[p.url]?.streak429 ?? 0) >= 2) return false; // 429 长冷却：兜底也不考虑
        if ((stats[p.url]?.deadFails ?? 0) >= DEAD_FAIL_THRESHOLD) return false; // 连接级永久失败：兜底也不考虑（否则每次白等一次拒连）
        return t - err < cooldownMs;
      })
      .sort((a, b) => (lastErrorAt[a.url] ?? 0) - (lastErrorAt[b.url] ?? 0));
  }

  function next() {
    const avail = available();
    if (!avail.length) return null;
    cursor = cursor % avail.length;
    return avail[cursor++];
  }

  // ——— 累计计数（排障读数，不参与选路） ———
  // 为什么单列而不是复用 fails/okAt：那两个是**瞬时**量（成功把 fails 清零、失败把 okAt 晾着），
  // 用来判"现在好不好用"；而"这个节点一共替我扛了多少次"必须只增不减，否则永远读不出分布。
  // day 分桶让「今天是不是某节点突然不干活了」一眼可见，历史桶只留 DAY_KEEP 天。
  const DAY_KEEP = 14;

  function todayKey() {
    const d = new Date(now());
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // 只在 acc（{wins,failTotal,days}）上加计数，不碰 stats[url]：
  // recordResult 的成功分支会**整体重建**该节点条目，早先那种"先写进 stats 再重建"
  // 的写法会把刚累加的计数直接抹掉（成功一次 = 归零一次，统计恒为 0）。
  function accOf(prev) {
    return { wins: prev.wins || 0, failTotal: prev.failTotal || 0, days: prev.days || {} };
  }

  function bumpDayInto(acc, field) {
    const days = { ...acc.days };
    const k = todayKey();
    const cur = days[k] || { ok: 0, fail: 0 };
    days[k] = { ok: cur.ok || 0, fail: cur.fail || 0, [field]: (cur[field] || 0) + 1 };
    const keys = Object.keys(days).sort();
    for (const old of keys.slice(0, Math.max(0, keys.length - DAY_KEEP))) delete days[old];
    acc.days = days;
  }

  // Long-lived error memory: a peer keeps its last-error timestamp until a
  // subsequent success resets it (success clears the failure record) or the
  // error is no longer in the persist store on next load.
  async function recordError(url, { status, message } = { }) {
    if (!url) return;
    lastErrorAt[url] = now();
    await persistErrors({ ...lastErrorAt });
    // 连续 429 计数（仅成功清零）：第 2 次起进入长冷却——该 peer 大概率真被限流，不再频繁试它
    if (Number(status) === 429) {
      const prev = stats[url] || {};
      stats[url] = { ...prev, streak429: (prev.streak429 || 0) + 1 };
      await persistStats({ ...stats });
    }
    // 连接级失败计数（仅成功清零）：第 2 次起进长冷却，且不再被 coolingByLastError 兜底捞回
    if (isConnLevelFailure(message)) {
      const prev = stats[url] || {};
      stats[url] = { ...prev, deadFails: (prev.deadFails || 0) + 1 };
      await persistStats({ ...stats });
    }
  }

  // Outcome of a forwarded request: ok updates the hot-cache (EMA latency,
  // last successful model) and clears the error memory; failures keep the
  // error timestamp so the retry pass can order by recovery time.
  // 累计计数（用户 2026-10-23）：okAt/fails 是**瞬时**状态（成功清 fails、失败清 okAt），
  // 看不出「这个节点一共替我扛了多少次」。故另立只增不减的 wins/failTotal 与今日分桶，
  // 用于回答「各节点成功转发次数是否合理」——它是排障读数，不参与选路打分。
  async function recordResult(url, { ok, latencyMs, model, provisional = false } = {}) {
    if (!url) return;
    if (ok) {
      if (lastErrorAt[url] != null) {
        delete lastErrorAt[url];
        await persistErrors({ ...lastErrorAt });
      }
      const prev = stats[url] || {};
      // ⚠ 成功分支用 next **整体重建**该节点条目（清 fails/streak429/deadFails 等瞬时量），
      // 所以累计量 wins/failTotal/days 必须经 acc 显式带回去——早先"先写 stats 再重建"的
      // 写法等于每次成功把累计抹掉（成功一次归零一次，统计恒为 0）。
      const next = {
        okAt: now(),
        latencyMs: prev.latencyMs != null && typeof latencyMs === "number"
          ? Math.round(prev.latencyMs * (1 - EMA_ALPHA) + latencyMs * EMA_ALPHA)
          : (typeof latencyMs === "number" ? latencyMs : prev.latencyMs ?? 0),
        fails: 0,
        model: model || prev.model || "",
        streak429: 0,
        deadFails: 0,
      };
      // 探测死亡标记：请求成功 = 节点活着，冷却窗口立即解除。
      // next 本身不含 probeDeadAt 键，天然清除；这里只兜底确保没有残留。
      const acc = accOf(prev);
      if (!provisional) {
        acc.wins += 1;
        bumpDayInto(acc, "ok");
      }
      stats[url] = { ...next, ...acc };
      delete stats[url].probeDeadAt;
    } else {
      const prev = stats[url] || {};
      const acc = accOf(prev);
      acc.failTotal += 1;
      bumpDayInto(acc, "fail");
      stats[url] = { ...prev, fails: (prev.fails || 0) + 1, ...acc };
    }
    await persistStats({ ...stats });
  }

  // 探测死亡标记（health 连不上）：probeDeadAt 置为此刻，10min 内冷却。不反复探。
  // recordProbeOk 在探测成功时清标记（节点回来了，冷却窗口立刻结束）。
  async function recordProbeDead(url) {
    if (!url) return;
    const prev = stats[url] || {};
    stats[url] = { ...prev, probeDeadAt: now() };
    await persistStats({ ...stats });
  }

  async function recordProbeOk(url) {
    if (!url) return;
    const prev = stats[url] || {};
    if (!("probeDeadAt" in prev)) return;
    delete prev.probeDeadAt;
    stats[url] = prev;
    await persistStats({ ...stats });
  }

  return {
    all, add, remove, removeByGroup, isCooling, isBroadbandCooling, isBroadbandStale: (url) => {
      const peer = list.find((p) => p.url === url);
      return peer ? isBroadbandStale(peer, now(), broadbandStaleMs()) : false;
    }, isHot, stat, ordered, orderedByLastError, coolingByLastError, available, next,
    standbyChain, nextStandby, isLeaderPeer,
    recordError, recordResult, recordProbeDead, recordProbeOk, errors: () => ({ ...lastErrorAt }), stats: () => ({ ...stats }),
    todayKey,
  };
}
