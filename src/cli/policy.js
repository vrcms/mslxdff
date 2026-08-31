import { readPid, readPidVersion, isPidAlive, stopDaemon } from "../daemon.js";
import { resolvePort } from "../server.js";
import { getPort, loadGroupsJoined } from "../state.js";

export function compareSemver(a, b) {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const av = pa[i] || 0, bv = pb[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

export function argValue(args, ...names) {
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i])) return args[i + 1];
  }
  return null;
}

export function effectivePort(args) {
  const arg = argValue(args, "-port", "--port");
  if (arg) return Number(arg);
  return resolvePort();
}

export function effectiveHost() {
  const envHost = process.env.MSLXDFF_HOST || process.env.MSLXDFF_BIND_HOST;
  if (typeof envHost === "string" && envHost.trim()) return envHost.trim();
  try {
    const joined = loadGroupsJoined();
    if (joined.some((g) => g.kind === "broadband")) return "127.0.0.1";
  } catch {}
  return "0.0.0.0";
}

export async function waitForHealth(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Only upgrade, never downgrade. Keeps a newer daemon running.
export function stopDaemonIfOutdated(VERSION) {
  const pid = readPid();
  if (!pid) return;
  if (!isPidAlive(pid)) {
    console.log(`daemon pid ${pid} is stale (not running) — starting fresh`);
    return;
  }
  const runningVersion = readPidVersion();
  if (!runningVersion) {
    console.log(`daemon version unknown — restarting with v${VERSION}...`);
    stopDaemon();
    return;
  }
  if (runningVersion === VERSION) return;
  const cmp = compareSemver(VERSION, runningVersion);
  if (cmp <= 0) {
    console.log(`daemon running v${runningVersion} — keeping v${runningVersion} (local v${VERSION} is lower, not downgrading)`);
    return;
  }
  console.log(`daemon running v${runningVersion} — upgrading to v${VERSION}, restarting...`);
  stopDaemon();
}

export function refreshIntervalMs() {
  const n = Number(process.env.MODELS_REFRESH_MS);
  return Number.isInteger(n) && n > 0 ? n : 2 * 60 * 60 * 1000;
}
export function modelCooldownMs() {
  const n = Number(process.env.MSLXDFF_MODEL_COOLDOWN_MS);
  return Number.isInteger(n) && n > 0 ? n : 60_000;
}
export function slowCooldownMs() {
  const n = Number(process.env.MSLXDFF_SLOW_COOLDOWN_MS);
  return Number.isInteger(n) && n > 0 ? n : 5 * 60_000;
}
export function peerCooldownMs() {
  const n = Number(process.env.MSLXDFF_PEER_COOLDOWN_MS);
  return Number.isInteger(n) && n > 0 ? n : 30_000;
}
export function peerHeatMs() {
  const n = Number(process.env.MSLXDFF_PEER_HEAT_MS);
  return Number.isInteger(n) && n > 0 ? n : 5 * 60_000;
}
export function maxHopsValue() {
  const n = Number(process.env.MSLXDFF_MAX_HOPS);
  return Number.isInteger(n) && n > 0 ? n : 3;
}
export function groupSyncIntervalMs() {
  const n = Number(process.env.MSLXDFF_GROUP_SYNC_MS);
  return Number.isInteger(n) && n > 0 ? n : 60_000;
}
export function autoUpdateIntervalMs() {
  const raw = process.env.MSLXDFF_AUTO_UPDATE_MS ?? process.env.MSLXDFF_AUTO_UPDATE;
  if (raw === undefined || raw === null || raw === "") return 60 * 60 * 1000;
  const s = String(raw).trim().toLowerCase();
  if (s === "0" || s === "off" || s === "false" || s === "no" || s === "disable" || s === "disabled") return 0;
  if (s === "1" || s === "true" || s === "on" || s === "yes" || s === "enable" || s === "enabled") return 60 * 60 * 1000;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 60 * 60 * 1000;
}
export function banWindowMs() {
  const n = Number(process.env.MSLXDFF_BAN_WINDOW_MS);
  return Number.isInteger(n) && n > 0 ? n : 48 * 60 * 60 * 1000;
}
export function banThreshold() {
  const n = Number(process.env.MSLXDFF_BAN_THRESHOLD);
  return Number.isInteger(n) && n > 0 ? n : 5;
}
