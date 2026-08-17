import { loadPeers, savePeers, loadPeerErrors, savePeerErrors } from "./state.js";

export const DEFAULT_PEER_COOLDOWN_MS = 30_000;
export const DEFAULT_MAX_HOPS = 3;

export function normalizePeerUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

export function createPeersService({
  file,
  now = () => Date.now(),
  cooldownMs = DEFAULT_PEER_COOLDOWN_MS,
  peers: seedPeers,
  errors: seedErrors,
  persistPeers = (list, f = file) => savePeers(list, f ? { file: f } : {}),
  persistErrors = (errors, f = file) => savePeerErrors(errors, f ? { file: f } : {}),
} = {}) {
  const list = (seedPeers ?? loadPeers(file ? { file } : {}))
    .map((p) => ({ ...p, url: normalizePeerUrl(p.url) }))
    .filter((p) => p && p.url);
  const lastErrorAt = { ...(seedErrors ?? loadPeerErrors(file ? { file } : {})) };

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

  return { all, add, remove, removeByGroup, isCooling, available, next, recordError, errors: () => ({ ...lastErrorAt }) };
}
