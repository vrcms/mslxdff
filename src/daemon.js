import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { writeExitMarker } from "./runtime/lifecycle-forensics.js";
import { findDaemons, fmtAlive } from "./runtime/proc-info.js";

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

export function stopDaemon({ reason = "stop" } = {}) {
  const pid = readPid();
  if (!pid) return { stopped: false, reason: "no pid file" };
  // 杀者牌（验尸官的另一半证据）：动手前写、自带死者身份。只给在世者留牌——给尸体留牌
  // 会让下次验尸把"早已静默死亡"误判成"被本次杀死"。
  const victimAlive = isPidAlive(pid);
  // 杀者留痕（写 daemon.log）：Windows 的 SIGTERM 是 TerminateProcess 强杀，被杀的 daemon
  // 在 JS 层收不到任何事件（无法自记），故由"杀者"记录调用方 pid——
  // 没有这行 = 非我方所杀（外部 taskkill/任务管理器/崩溃），配合最后一条 heartbeat 定位死亡时刻。
  try {
    appendFileSync(logFile(), `[lifecycle] stopDaemon called by pid=${process.pid} — killing daemon pid=${pid}\n`);
  } catch {}
  if (victimAlive) { try { writeExitMarker(daemonDir(), { reason, prevPid: pid, prevVersion: readPidVersion(), byPid: process.pid }); } catch {} }
  let killFailed = false;
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    if (err.code === "ESRCH") {
      // process already gone — nothing to do
    } else if (err.code === "EPERM" && process.platform === "win32") {
      // Windows: process.kill uses TerminateProcess which requires matching elevation.
      // Fall back to taskkill /F which can terminate processes we don't own a handle to.
      const r = spawnSync("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true });
      if (r.error || r.status !== 0) killFailed = true;
    } else {
      throw err;
    }
  }
  try {
    unlinkSync(pidFile());
  } catch {
    // already gone
  }
  if (killFailed) return { stopped: false, pid, reason: "EPERM — process kill denied (try running terminal as Administrator, or use restart-daemon.bat)" };
  return { stopped: true, pid, stale: !victimAlive };
}

/**
 * 等目标进程真的死掉，超时补 SIGKILL。返回 { died, forced, waitedMs }。
 * 为什么必须有：只发 SIGTERM 就 spawn 新 daemon，会留下「收到信号但退不出去」的幽灵
 * （隧道子进程把事件循环钉住）——它不在 daemon.pid 里，从此 `-restart` 结构性碰不到它。
 */
export async function waitPidGone(pid, { timeoutMs = 5000, killWaitMs = 2000, stepMs = 100, kill = process.kill, isAlive = isPidAlive, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const t0 = Date.now();
  while (isAlive(pid) && Date.now() - t0 < timeoutMs) await sleep(stepMs);
  if (!isAlive(pid)) return { died: true, forced: false, waitedMs: Date.now() - t0 };
  try { kill(pid, "SIGKILL"); } catch {}
  const t1 = Date.now();
  while (isAlive(pid) && Date.now() - t1 < killWaitMs) await sleep(stepMs);
  return { died: !isAlive(pid), forced: true, waitedMs: Date.now() - t0 };
}

/**
 * 清「不在 daemon.pid 里的」幽灵 daemon —— `-restart` 的结构性盲区
 *（真机事故：旧 daemon 活了一整天，与新版互杀 warp-pool 端口，两边日志格式交错才暴露）。
 * 先 SIGTERM 全清 → 等 5s → 仍活着的 SIGKILL。返回**确实清掉**的清单（供调用方诚实汇报）。
 */
export async function reapGhostDaemons({ self = process.pid, list = () => findDaemons({ self }), kill = process.kill, log = () => {}, isAlive = isPidAlive, settleMs = 5000, killWaitMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const ghosts = list();
  if (!ghosts.length) return [];
  for (const g of ghosts) log(`[daemon] 发现不在册的 daemon pid=${g.pid}（父 ${g.ppid}，已运行 ${fmtAlive(g.aliveSec)}）—— -restart 杀不到它，清掉`);
  for (const g of ghosts) { try { kill(g.pid, "SIGTERM"); } catch {} }
  const t0 = Date.now();
  while (Date.now() - t0 < settleMs && ghosts.some((g) => isAlive(g.pid))) await sleep(100);
  const stuck = ghosts.filter((g) => isAlive(g.pid));
  for (const g of stuck) { try { kill(g.pid, "SIGKILL"); } catch {} }
  const t1 = Date.now();
  while (Date.now() - t1 < killWaitMs && stuck.some((g) => isAlive(g.pid))) await sleep(100);
  return ghosts.filter((g) => !isAlive(g.pid));
}
