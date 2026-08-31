import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import os from "node:os";
import { loadFromDisk, atomicWriteSync, getMtimeMs, ensureDir } from "./persist.js";
import { mergeState, COLD_WINS } from "./merge.js";

export const DEFAULT_PORT = 8989;

function isTestEnv() {
  if (process.env.NODE_ENV === "test") return true;
  if (process.env.MSLXDFF_STATE_FILE && String(process.env.MSLXDFF_STATE_FILE).includes("mslxdff-test")) return true;
  if (process.argv.some((a) => String(a).includes("--test") || String(a).endsWith(".test.js"))) return true;
  if (Array.isArray(process.execArgv) && process.execArgv.some((a) => String(a).includes("--test"))) return true;
  if (process.env.NODE_TEST_CONTEXT) return true;
  return false;
}

export function defaultStateFile() {
  if (process.env.MSLXDFF_STATE_FILE) return process.env.MSLXDFF_STATE_FILE;
  if (isTestEnv()) return join(os.tmpdir(), "mslxdff-test-state.json");
  return join(os.homedir(), ".config", "mslxdff", "state.json");
}

export function tokenFile(file) {
  if (process.env.MSLXDFF_TOKEN_FILE) return process.env.MSLXDFF_TOKEN_FILE;
  const sf = file || defaultStateFile();
  const realDefault = join(os.homedir(), ".config", "mslxdff", "state.json");
  if (sf !== realDefault) return join(dirname(sf), "token");
  if (isTestEnv()) return join(os.tmpdir(), "mslxdff-test-token");
  return join(os.homedir(), ".config", "mslxdff", "token");
}

export function generateToken() {
  return randomBytes(32).toString("hex");
}

// ---- 缓存层：读走内存，写分“热/冷”两档，热数据 500ms 批量刷盘 ----
const stateCache = new Map(); // file -> { data, dirty, timer, mtimeMs }
const FLUSH_MS = (() => {
  const n = Number(process.env.MSLXDFF_STATE_FLUSH_MS);
  return Number.isInteger(n) && n >= 0 ? n : 500;
})();

function getEntry(file) {
  let e = stateCache.get(file);
  if (!e) {
    e = { data: null, dirty: false, timer: null, mtimeMs: 0 };
    stateCache.set(file, e);
  }
  return e;
}

// 合并规则已抽至 merge.js 单一真相

function readState(file) {
  const e = getEntry(file);
  if (e.data !== null) {
    try {
      const st = statSync(file);
      if (st.mtimeMs === e.mtimeMs) return e.data;
      if (e.dirty) {
        const disk = loadFromDisk(file);
        const diskObj = typeof disk === "object" && disk !== null ? disk : {};
        const merged = mergeState(diskObj, e.data);
        e.data = merged;
        e.mtimeMs = st.mtimeMs;
        return e.data;
      }
    } catch {
      if (e.data) return e.data;
    }
  }
  const disk = loadFromDisk(file);
  const obj = typeof disk === "object" && disk !== null ? disk : {};
  e.data = obj;
  try {
    const st = statSync(file);
    e.mtimeMs = st.mtimeMs;
  } catch {
    e.mtimeMs = Date.now();
  }
  e.dirty = false;
  return e.data;
}

function writeStateImmediate(file, patch) {
  const e = getEntry(file);
  const base = e.data !== null ? e.data : readState(file);
  const merged = { ...base, ...patch };
  e.data = merged;
  e.dirty = false;
  if (e.timer) {
    clearTimeout(e.timer);
    e.timer = null;
  }
  ensureDir(file);
  const mtime = atomicWriteSync(file, merged);
  e.mtimeMs = mtime;
  return merged;
}

function scheduleFlush(file) {
  const e = getEntry(file);
  if (e.timer) return;
  if (FLUSH_MS === 0) {
    flushStateSync(file);
    return;
  }
  e.timer = setTimeout(() => {
    e.timer = null;
    void flushState(file);
  }, FLUSH_MS);
  e.timer.unref?.();
}

async function flushState(file) {
  const e = stateCache.get(file);
  if (!e || !e.dirty || !e.data) return;
  const snapshot = e.data;
  try {
    ensureDir(file);
    const mtime = await atomicWriteAsync(file, snapshot);
    e.dirty = false;
    e.mtimeMs = mtime;
  } catch {
    // retain dirty
  }
}

function writeStateDeferred(file, patch) {
  const e = getEntry(file);
  const base = e.data !== null ? e.data : readState(file);
  const merged = { ...base, ...patch };
  e.data = merged;
  e.dirty = true;
  scheduleFlush(file);
  return merged;
}

export function flushStateSync(file = defaultStateFile()) {
  const e = stateCache.get(file);
  if (!e || !e.dirty || !e.data) return;
  try {
    ensureDir(file);
    const mtime = atomicWriteSync(file, e.data);
    e.dirty = false;
    e.mtimeMs = mtime;
    if (e.timer) {
      clearTimeout(e.timer);
      e.timer = null;
    }
  } catch {}
}

export function clearStateCache(file) {
  if (file) stateCache.delete(file);
  else stateCache.clear();
}

// internal helper for facade compat
function writeState(file, patch) {
  return writeStateImmediate(file, patch);
}

export {
  readState,
  writeStateImmediate,
  writeStateDeferred,
  scheduleFlush,
  flushState,
  writeState,
  getEntry,
  stateCache,
};
