import { defaultStateFile, readState, writeStateImmediate, writeStateDeferred } from "../store.js";

export function loadPeers({ file = defaultStateFile() } = {}) {
  const peers = readState(file).peers;
  return Array.isArray(peers) ? peers : [];
}

export function savePeers(peers, { file = defaultStateFile() } = {}) {
  writeStateImmediate(file, { peers });
  return peers;
}

export function loadPeerErrors({ file = defaultStateFile() } = {}) {
  const errors = readState(file).peerErrors;
  return errors && typeof errors === "object" && !Array.isArray(errors) ? errors : {};
}

export function savePeerErrors(errors, { file = defaultStateFile() } = {}) {
  writeStateDeferred(file, { peerErrors: errors });
  return errors;
}

export function loadPeerStats({ file = defaultStateFile() } = {}) {
  const stats = readState(file).peerStats;
  return stats && typeof stats === "object" && !Array.isArray(stats) ? stats : {};
}

export function savePeerStats(stats, { file = defaultStateFile() } = {}) {
  writeStateDeferred(file, { peerStats: stats });
  return stats;
}
