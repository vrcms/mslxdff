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

  // Available peers ordered for failover: hot (recent success, low latency,
  // few failures) first, cold/unused peers last.
  function ordered(t = now()) {
    return available().sort((a, b) => rankScore(a, t) - rankScore(b, t));
  }

  let cursor = 0;

  function next() {
    const avail = available();
    if (!avail.length) return null;
    cursor = cursor % avail.length;
    return avail[cursor++];
  }

  async function recordError(url) {
    if (!url) return;
    lastErrorAt[url] = now();
    await persistErrors({ ...lastErrorAt });
  }

  // Outcome of a forwarded request: ok updates the hot-cache (EMA latency,
  // last successful model); failures bump the consecutive-failure counter.
  async function recordResult(url, { ok, latencyMs, model } = {}) {
    if (!url) return;
    if (ok) {
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

  return { all, add, remove, removeByGroup, isCooling, isHot, stat, ordered, available, next, recordError, recordResult, errors: () => ({ ...lastErrorAt }), stats: () => ({ ...stats }) };
}
