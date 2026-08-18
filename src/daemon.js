import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export function daemonDir() {
  return process.env.MSLXDFF_DAEMON_DIR || join(os.homedir(), ".config", "mslxdff");
}

export function pidFile() {
  return join(daemonDir(), "daemon.pid");
}

export function logFile() {
  return join(daemonDir(), "daemon.log");
}

export function startDaemon(args = []) {
  const here = fileURLToPath(import.meta.url);
  const entry = here.endsWith("bin/mslxdff.js")
    ? here
    : join(dirname(here), "..", "bin", "mslxdff.js");
  const dir = daemonDir();
  mkdirSync(dir, { recursive: true });
  const logFd = openSync(logFile(), "a", 0o600);
  const child = spawn(process.execPath, [entry, ...args, "--daemon"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, MSLXDFF_DAEMON: "1" },
  });
  child.unref();
  return child.pid;
}

export function writePid(pid, version) {
  const dir = daemonDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(pidFile(), version ? `${pid}\n${version}` : String(pid), { mode: 0o600 });
}

export function readPid() {
  if (!existsSync(pidFile())) return null;
  const raw = readFileSync(pidFile(), "utf8").trim();
  const n = Number(raw.split("\n")[0]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function readPidVersion() {
  if (!existsSync(pidFile())) return null;
  const raw = readFileSync(pidFile(), "utf8");
  const lines = raw.split("\n");
  return lines.length > 1 && lines[1].trim() ? lines[1].trim() : null;
}

// Best-effort liveness check (signal 0); ESRCH means the process is gone.
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
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
