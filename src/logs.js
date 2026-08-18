import { appendFileSync, readFileSync, mkdirSync, existsSync, writeFileSync, statSync } from "node:fs";
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

function appendLine(file, entry) {
  ensureDir(dirname(file));
  appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  trimIfOversized(file);
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
