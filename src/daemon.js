import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
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

// 当前代码所在的 CLI 入口（bin/mslxdff.js 绝对路径）：startDaemon 与
// auto-update 的 -restart 委托共用（后者从 daemon 进程 spawn 时必须指向同一份代码）。
export function daemonEntry() {
  const here = fileURLToPath(import.meta.url);
  return here.endsWith("bin/mslxdff.js")
    ? here
    : join(dirname(here), "..", "bin", "mslxdff.js");
}

export function startDaemon(args = []) {
  const entry = daemonEntry();
  const dir = daemonDir();
  mkdirSync(dir, { recursive: true });
  const logFd = openSync(logFile(), "a", 0o600);
  const env = { ...process.env, MSLXDFF_DAEMON: "1" };
  // a -debug foreground session wouldn't pass MSLXDFF_DEBUG to the
  // background daemon it restores (that flag means "print events to stdout")
  delete env.MSLXDFF_DEBUG;
  const child = spawn(process.execPath, [entry, ...args, "--daemon"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env,
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
  // 杀者留痕（写 daemon.log）：Windows 的 SIGTERM 是 TerminateProcess 强杀，被杀的 daemon
  // 在 JS 层收不到任何事件（无法自记），故由"杀者"记录调用方 pid——
  // 没有这行 = 非我方所杀（外部 taskkill/任务管理器/崩溃），配合最后一条 heartbeat 定位死亡时刻。
  try {
    appendFileSync(logFile(), `[lifecycle] stopDaemon called by pid=${process.pid} — killing daemon pid=${pid}\n`);
  } catch {}
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
