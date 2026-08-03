import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export function daemonDir() {
  return process.env.MSLXDFREE_DAEMON_DIR || join(os.homedir(), ".config", "mslxdfree");
}

export function pidFile() {
  return join(daemonDir(), "daemon.pid");
}

export function logFile() {
  return join(daemonDir(), "daemon.log");
}

export function startDaemon(args = []) {
  const here = fileURLToPath(import.meta.url);
  const entry = here.endsWith("bin/mslxdfree.js")
    ? here
    : join(dirname(here), "..", "bin", "mslxdfree.js");
  const dir = daemonDir();
  mkdirSync(dir, { recursive: true });
  const logFd = openSync(logFile(), "a", 0o600);
  const child = spawn(process.execPath, [entry, ...args, "--daemon"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, MSLXDFREE_DAEMON: "1" },
  });
  child.unref();
  return child.pid;
}

export function writePid(pid) {
  const dir = daemonDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(pidFile(), String(pid), { mode: 0o600 });
}

export function readPid() {
  if (!existsSync(pidFile())) return null;
  const raw = readFileSync(pidFile(), "utf8").trim();
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function stopDaemon() {
  const pid = readPid();
  if (!pid) return { stopped: false, reason: "no pid file" };
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    if (err.code !== "ESRCH") throw err;
  }
  try {
    unlinkSync(pidFile());
  } catch {
    // already gone
  }
  return { stopped: true, pid };
}
