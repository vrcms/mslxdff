import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";

export const DEFAULT_PORT = 8989;

export function defaultStateFile() {
  return process.env.MSLXDFF_STATE_FILE ||
    join(os.homedir(), ".config", "mslxdff", "state.json");
}

export function generateToken() {
  return randomBytes(32).toString("hex");
}

export async function loadToken({ file = defaultStateFile() } = {}) {
  const state = readState(file);
  if (typeof state.token === "string" && state.token.length > 0) {
    return { token: state.token, created: false };
  }
  return { token: writeState(file, { token: generateToken(), createdAt: new Date().toISOString() }).token, created: true };
}

export async function refreshToken({ file = defaultStateFile() } = {}) {
  return writeState(file, { token: generateToken(), createdAt: new Date().toISOString() }).token;
}

export function setPort(port, { file = defaultStateFile() } = {}) {
  const state = readState(file);
  writeState(file, { ...state, port: Number(port) });
}

export function getPort({ file = defaultStateFile() } = {}) {
  const port = readState(file).port;
  return typeof port === "number" && Number.isInteger(port) && port > 0 ? port : null;
}

export function loadModelErrors({ file = defaultStateFile() } = {}) {
  const errors = readState(file).modelErrors;
  return errors && typeof errors === "object" && !Array.isArray(errors) ? errors : {};
}

export function saveModelErrors(errors, { file = defaultStateFile() } = {}) {
  const state = readState(file);
  writeState(file, { ...state, modelErrors: errors });
  return errors;
}

export function loadModelLatencies({ file = defaultStateFile() } = {}) {
  const lat = readState(file).modelLatencies;
  return lat && typeof lat === "object" && !Array.isArray(lat) ? lat : {};
}

export function saveModelLatencies(latencies, { file = defaultStateFile() } = {}) {
  const state = readState(file);
  writeState(file, { ...state, modelLatencies: latencies });
  return latencies;
}

export function loadPreferredModel({ file = defaultStateFile() } = {}) {
  const v = readState(file).preferredModel;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function savePreferredModel(id, { file = defaultStateFile() } = {}) {
  const state = readState(file);
  writeState(file, { ...state, preferredModel: String(id || "").trim() });
  return String(id || "").trim();
}

export function loadPeers({ file = defaultStateFile() } = {}) {
  const peers = readState(file).peers;
  return Array.isArray(peers) ? peers : [];
}

export function savePeers(peers, { file = defaultStateFile() } = {}) {
  const state = readState(file);
  writeState(file, { ...state, peers });
  return peers;
}

export function loadPeerErrors({ file = defaultStateFile() } = {}) {
  const errors = readState(file).peerErrors;
  return errors && typeof errors === "object" && !Array.isArray(errors) ? errors : {};
}

export function savePeerErrors(errors, { file = defaultStateFile() } = {}) {
  const state = readState(file);
  writeState(file, { ...state, peerErrors: errors });
  return errors;
}

export function loadPeerStats({ file = defaultStateFile() } = {}) {
  const stats = readState(file).peerStats;
  return stats && typeof stats === "object" && !Array.isArray(stats) ? stats : {};
}

export function savePeerStats(stats, { file = defaultStateFile() } = {}) {
  const state = readState(file);
  writeState(file, { ...state, peerStats: stats });
  return stats;
}

export function loadGroups({ file = defaultStateFile() } = {}) {
  const groups = readState(file).groups;
  return groups && typeof groups === "object" && !Array.isArray(groups) ? groups : {};
}

export function loadGroupsJoined({ file = defaultStateFile() } = {}) {
  const joined = readState(file).groupsJoined;
  return Array.isArray(joined) ? joined : [];
}

export function saveGroupsJoined(joined, { file = defaultStateFile() } = {}) {
  const state = readState(file);
  writeState(file, { ...state, groupsJoined: joined });
  return joined;
}

export function loadBans({ file = defaultStateFile() } = {}) {
  const bans = readState(file).bans;
  return bans && typeof bans === "object" && !Array.isArray(bans) ? bans : {};
}

export function saveBans(bans, { file = defaultStateFile() } = {}) {
  const state = readState(file);
  writeState(file, { ...state, bans });
  return bans;
}

export function saveGroups(groups, { file = defaultStateFile() } = {}) {
  const state = readState(file);
  writeState(file, { ...state, groups });
  return groups;
}

function readState(file) {
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    return typeof saved === "object" && saved !== null ? saved : {};
  } catch {
    return {};
  }
}

function writeState(file, patch) {
  const merged = { ...readState(file), ...patch };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
}
