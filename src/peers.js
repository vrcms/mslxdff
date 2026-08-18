import { loadPeers, savePeers, loadPeerErrors, savePeerErrors, loadPeerStats, savePeerStats } from "./state.js";

export const DEFAULT_PEER_COOLDOWN_MS = 30_000;
export const DEFAULT_PEER_HEAT_MS = 5 * 60_000;
export const DEFAULT_MAX_HOPS = 3;

const EMA_ALPHA = 0.3;

export function normalizePeerUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

export function createPeersService({
  file,
  now = () => Date.now(),
  cooldownMs = DEFAULT_PEER_COOLDOWN_MS,
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

  function isCooling(url) {
    if (!cooldownMs) return false;
    const err = lastErrorAt[url];
    return typeof err === "number" && now() - err < cooldownMs;
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

  // Available peers ordered for failover: hot peers (recent success) first —
  // the winner of the last race is reused next. Everyone else is ordered by
  // when they last failed, earliest first: a peer that failed longer ago has
  // had more time to recover, so it is tried before a more recent failure.
  // Peers with no recorded error go after any that failed.
  function ordered(t = now()) {
    return available().sort((a, b) => {
      const hotA = stats[a.url]?.okAt && t - stats[a.url].okAt < heatMs ? 0 : 1;
      const hotB = stats[b.url]?.okAt && t - stats[b.url].okAt < heatMs ? 0 : 1;
      if (hotA !== hotB) return hotA - hotB;
      const ea = lastErrorAt[a.url];
      const eb = lastErrorAt[b.url];
      if (ea == null && eb == null) return 0;
      if (ea == null) return 1; // never-failed peers go after any that failed
      if (eb == null) return -1;
      return ea - eb; // earliest failure first
    });
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

  function next() {
    const avail = available();
    if (!avail.length) return null;
    cursor = cursor % avail.length;
    return avail[cursor++];
  }

  // Long-lived error memory: a peer keeps its last-error timestamp until a
  // subsequent success resets it (success clears the failure record) or the
  // error is no longer in the persist store on next load.
  async function recordError(url) {
    if (!url) return;
    lastErrorAt[url] = now();
    await persistErrors({ ...lastErrorAt });
  }

  // Outcome of a forwarded request: ok updates the hot-cache (EMA latency,
  // last successful model) and clears the error memory; failures keep the
  // error timestamp so the retry pass can order by recovery time.
  async function recordResult(url, { ok, latencyMs, model } = {}) {
    if (!url) return;
    if (ok) {
      if (lastErrorAt[url] != null) {
        delete lastErrorAt[url];
        await persistErrors({ ...lastErrorAt });
      }
      const prev = stats[url] || {};
      stats[url] = {
        okAt: now(),
        latencyMs: prev.latencyMs != null && typeof latencyMs === "number"
          ? Math.round(prev.latencyMs * (1 - EMA_ALPHA) + latencyMs * EMA_ALPHA)
          : (typeof latencyMs === "number" ? latencyMs : prev.latencyMs ?? 0),
        fails: 0,
        model: model || prev.model || "",
      };
    } else {
      const prev = stats[url] || {};
      stats[url] = { ...prev, fails: (prev.fails || 0) + 1 };
    }
    await persistStats({ ...stats });
  }

  return {
    all, add, remove, removeByGroup, isCooling, isHot, stat, ordered, orderedByLastError, available, next,
    recordError, recordResult, errors: () => ({ ...lastErrorAt }), stats: () => ({ ...stats }),
  };
}
