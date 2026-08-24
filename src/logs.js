import { appendFileSync, readFileSync, mkdirSync, existsSync, writeFileSync, statSync } from "node:fs";
import { appendFile, stat, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import os from "node:os";
import { defaultStateFile } from "./state.js";

const MAX_CALLS = 500;
const MAX_ERRORS = 200;
const MAX_BYTES = 1024 * 1024;

export function logDir() {
  return process.env.MSLXDFF_DAEMON_DIR || dirname(defaultStateFile());
}

export function callsFile() {
  return join(logDir(), "calls.log");
}

export function errorsFile() {
  return join(logDir(), "errors.log");
}

export function eventsFile() {
  return join(logDir(), "events.log");
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function trimIfOversized(file, maxBytes = MAX_BYTES) {
  try {
    const st = statSync(file);
    if (st.size <= maxBytes) return;
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    const keep = lines.slice(-100);
    writeFileSync(file, keep.join("\n"));
  } catch {
    // ignore
  }
}

async function trimIfOversizedAsync(file, maxBytes = MAX_BYTES) {
  try {
    const st = await stat(file);
    if (st.size <= maxBytes) return;
    const text = await readFile(file, "utf8");
    const lines = text.split("\n");
    const keep = lines.slice(-100);
    await writeFile(file, keep.join("\n"));
  } catch {
    // ignore
  }
}

function shouldSync(file) {
  if (process.env.MSLXDFF_LOGS_SYNC === "1") return true;
  if (process.env.MSLXDFF_DAEMON_DIR) {
    const dir = process.env.MSLXDFF_DAEMON_DIR;
    if (file.startsWith(dir)) return true;
  }
  // 显式 tmp 文件（所有 test 的 mkdtemp 前缀）走同步，保证 read-after-write 可见
  const low = file.toLowerCase();
  if (low.includes("mslxdff-") || low.includes("tmp") || low.includes("temp")) return true;
  // 非默认目录的文件一律同步（测试传入的临时路径）
  try {
    const def = logDir().toLowerCase();
    if (!low.startsWith(def)) return true;
  } catch {}
  return false;
}

function appendLine(file, entry) {
  ensureDir(dirname(file));
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  if (shouldSync(file)) {
    appendFileSync(file, line);
    trimIfOversized(file);
    return;
  }
  // 线上异步：不阻塞事件循环
  appendFile(file, line)
    .catch(() => {})
    .then(() => trimIfOversizedAsync(file).catch(() => {}));
}

export function appendCall(entry, { file = callsFile() } = {}) {
  appendLine(file, entry);
}

export function appendError(entry, { file = errorsFile() } = {}) {
  appendLine(file, entry);
}

// Structured debug event stream: one JSON line per request/error/forward
// step, consumed live by `mslxdff -debug`.
export function appendEvent(entry, { file = eventsFile() } = {}) {
  appendLine(file, entry);
}

export function recentEvents(n = 100, { file = eventsFile() } = {}) {
  return readLines(file).slice(-n);
}

function readLines(file) {
  try {
    if (!existsSync(file)) return [];
    const text = readFileSync(file, "utf8");
    return text.split("\n").filter(Boolean).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export function recentCalls(n = 5, { file = callsFile() } = {}) {
  return readLines(file).slice(-n);
}

export function lastError({ file = errorsFile() } = {}) {
  const lines = readLines(file);
  return lines.length ? lines[lines.length - 1] : null;
}

export function recentErrors(n = 5, { file = errorsFile() } = {}) {
  return readLines(file).slice(-n);
}
