import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { markerFile, writeExitMarker } from "./runtime/lifecycle-forensics.js";
import { aliveSec, findDaemons, fmtAlive } from "./runtime/proc-info.js";

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

// daemon.log 是唯一能事后回溯崩溃的载体（uncaughtException 堆栈、[sdk-upstream] 诊断），
// 却是全仓唯一**没有**任何大小上限的日志（实测 7MB / 60,321 行且持续增长）——与 events/calls/errors
// 的桶管理完全不对称。子进程以追加 fd 持着它，运行中改名会让 fd 跟着旧 inode（写进 .1），故轮转
// 放在**父进程启动时**：每次起 daemon 先轮转，再开新 fd，子进程永远写新文件。
const DAEMON_LOG_MAX_BYTES = (() => {
  const n = Number(process.env.MSLXDFF_DAEMON_LOG_MAX_BYTES);
  return Number.isInteger(n) && n > 0 ? n : 8 * 1024 * 1024;
})();

/** 超过阈值就把 daemon.log 改名成 .1（原 .1 → .2），只留两代。返回是否发生了轮转。 */
export function rotateDaemonLog(maxBytes = DAEMON_LOG_MAX_BYTES) {
  const file = logFile();
  try {
    if (!existsSync(file)) return false;
    if (statSync(file).size <= maxBytes) return false;
    const one = `${file}.1`;
    const two = `${file}.2`;
    try { if (existsSync(one)) renameSync(one, two); } catch {}
    renameSync(file, one);
    return true;
  } catch {
    return false; // 轮转失败绝不阻断启动：日志写不进去是遗憾，daemon 起不来是事故
  }
}

export function startDaemon(args = []) {
  const entry = daemonEntry();
  const dir = daemonDir();
  mkdirSync(dir, { recursive: true });
  const rotated = rotateDaemonLog();
  const logFd = openSync(logFile(), "a", 0o600);
  if (rotated) { try { appendFileSync(logFd, `[daemon] 上一份日志超过 ${DAEMON_LOG_MAX_BYTES} 字节，已轮转为 daemon.log.1\n`); } catch {} }
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

export function stopDaemon({ reason = "stop", kill = process.kill, taskkill = spawnSync, isAlive = isPidAlive } = {}) {
  const pid = readPid();
  if (!pid) return { stopped: false, reason: "no pid file" };
  // 自杀护栏（最高优先级）：pid 文件里写着**本进程**时，杀它就是杀自己。
  // 这不是假想情形 —— daemon 自己 `writePid(process.pid)`（server-lifecycle.js），而 `enableAutostart()`
  // 会在 systemd 托管下被 daemon 自己调起（server-lifecycle 的 autostart 自检块）：systemd **系统** unit
  // 的 daemon 去查 **user** unit 必然判「未启用」⇒ 走进 enableAutostart ⇒ stopDaemon ⇒ SIGTERM 自己
  // ⇒ 优雅关停 exit 0 ⇒ systemd Restart=always 拉起 ⇒ 每 2.5 秒一轮的无限重启
  //（真机 2026-10-19：0.1.209 + 系统 unit，每进程活 2~3s 被 SIGTERM；0.1.160 不炸只因当时
  //  `enableAutostart` 里 import 路径写错、这段从未执行过，2026-10-17 c7bf8af 修正路径后暴露）。
  if (pid === process.pid) {
    try {
      appendFileSync(logFile(), `[lifecycle] stopDaemon refused: pid file points at self (pid=${pid}, reason=${reason})\n`);
    } catch {}
    return { stopped: false, pid, reason: "self — pid 文件写的就是本进程，拒绝自杀" };
  }

  // 杀者牌（验尸官的另一半证据）：动手前写、自带死者身份。只给在世者留牌——给尸体留牌
  // 会让下次验尸把"早已静默死亡"误判成"被本次杀死"。
  const victimAlive = isAlive(pid);
  // 杀者留痕（写 daemon.log）：Windows 的 SIGTERM 是 TerminateProcess 强杀，被杀的 daemon
  // 在 JS 层收不到任何事件（无法自记），故由"杀者"记录调用方 pid——
  // 没有这行 = 非我方所杀（外部 taskkill/任务管理器/崩溃），配合最后一条 heartbeat 定位死亡时刻。
  try {
    appendFileSync(logFile(), `[lifecycle] stopDaemon called by pid=${process.pid} — killing daemon pid=${pid}\n`);
  } catch {}
  if (victimAlive) { try { writeExitMarker(daemonDir(), { reason, prevPid: pid, prevVersion: readPidVersion(), byPid: process.pid }); } catch {} }
  let killFailed = false;
  // 杀失败必须撤销杀者牌：牌是「我杀成了」的声明，collectAutopsy 见新鲜牌即判 killed-by-cli；
  // 留在盘上等于给**仍在世的** daemon 提前开出一份假死亡证明（下次启动把它记成"已被杀死"）。
  const dropMarker = () => { try { unlinkSync(markerFile(daemonDir())); } catch {} };
  try {
    kill(pid, "SIGTERM");
  } catch (err) {
    if (err.code === "ESRCH") {
      // process already gone — nothing to do
    } else if (err.code === "EPERM" && process.platform === "win32") {
      // Windows: process.kill uses TerminateProcess which requires matching elevation.
      // Fall back to taskkill /F which can terminate processes we don't own a handle to.
      const r = taskkill("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true });
      if (r?.error || r?.status !== 0) killFailed = true;
    } else {
      dropMarker(); // 同一笔账：没杀成就不许留牌
      throw err;
    }
  }
  // 杀失败 = 进程还活着 ⇒ **pid 文件必须留着**。删了它，这个仍在监听端口的 daemon 就从 pid 台账里
  // 消失，变成 `-restart` 结构性碰不到的幽灵（daemon.js:158 记录的真机事故类型）：下一轮 readPid()
  // 返回 null ⇒ -stop 打印「not running」、-restart 直接起新的与它抢端口，而它其实一直在跑。
  if (killFailed) {
    dropMarker();
    return { stopped: false, pid, reason: "EPERM — process kill denied (try running terminal as Administrator, or use restart-daemon.bat)" };
  }
  try {
    unlinkSync(pidFile());
  } catch {
    // already gone
  }
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
 *（真机事故：旧 daemon 活了一整天，与新版互抢本机端口，两边日志格式交错才暴露）。
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

/**
 * 接管：内存里若还有**别的** mslxdff daemon，先把比我们旧的那批请出去。
 * 为什么必须有（用户点名要求 + 真机 2026-10-17 事故）：`-restart` 只认 `daemon.pid`，
 * 不在册的 daemon（SIGTERM 后没真退出、pid 文件又被删掉的那个）会活一整天，与新版互抢
 * 本机那 4 个长驻端口（当年是 warp-pool 的 wireproxy，该模块已随 ADR-0073 移除）——日志里只能看到「起一条死一条」，看不出是两个 daemon 在互杀。
 * 判据：比自己早启动 ≥ `minAgeMs` 的一律清（SIGTERM → 等 → SIGKILL）；与本次启动几乎同时的不动
 * （谁该活由 8989 的 bind 决定，`server-lifecycle` 的 EADDRINUSE 自愈会收口），避免两边互杀。
 * 全程不抛（接管失败绝不能挡住启动）。
 * @returns {Promise<{killed:number[], skipped:number[], remaining:number[]}>}
 */
export async function takeoverOlderDaemons({
  self = process.pid,
  list = () => findDaemons({ self }),
  kill = process.kill,
  isAlive = isPidAlive,
  log = () => {},
  minAgeMs = 3000,
  settleMs = 5000,
  killWaitMs = 2000,
  myAliveSec = undefined,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const sibs = list();
  if (!sibs.length) return { killed: [], skipped: [], remaining: [] };
  const mine = myAliveSec === undefined ? aliveSec(self) : myAliveSec;
  // 取不到运行时长（非 Linux / 读不到 /proc）时保守处理：一律当成「旧的」，因为只允许一个 daemon 活着
  const isOlder = (d) => mine == null || d.aliveSec == null || (d.aliveSec - mine) * 1000 >= minAgeMs;
  const older = sibs.filter(isOlder);
  const skipped = sibs.filter((d) => !isOlder(d));

  for (const d of older) log(`[daemon] 内存里还有别的 mslxdff daemon：pid ${d.pid}（父 ${d.ppid}，已运行 ${fmtAlive(d.aliveSec)}，比本进程旧）—— 先请它退出，否则两个 daemon 会抢同一批端口（当年是 warp-pool 起一条死一条的真因，该模块已随 ADR-0073 移除）`);
  for (const d of older) { try { kill(d.pid, "SIGTERM"); } catch {} }
  const t0 = Date.now();
  while (Date.now() - t0 < settleMs && older.some((d) => isAlive(d.pid))) await sleep(100);
  const stuck = older.filter((d) => isAlive(d.pid));
  for (const d of stuck) log(`[daemon] pid ${d.pid} 收到 SIGTERM 后 ${Math.round((Date.now() - t0) / 1000)}s 仍没退，补 SIGKILL`);
  for (const d of stuck) { try { kill(d.pid, "SIGKILL"); } catch {} }
  const t1 = Date.now();
  while (Date.now() - t1 < killWaitMs && stuck.some((d) => isAlive(d.pid))) await sleep(100);

  const remaining = older.filter((d) => isAlive(d.pid));
  const killed = older.filter((d) => !isAlive(d.pid)).map((d) => d.pid);
  for (const d of skipped) log(`[daemon] ⚠ 同机还有 pid ${d.pid}（与本次启动几乎同时，不是旧的）—— 不动它，由 8989 的 bind 决定谁活`);
  if (remaining.length) log(`[daemon] ⚠ 请不走：pid ${remaining.map((d) => d.pid).join(",")}（SIGKILL 都没用，可能是僵尸或权限不足）—— 它仍会抢端口，请手动 kill -9`);
  else if (killed.length) log(`[daemon] ✓ 已请走 ${killed.length} 个旧 daemon（pid ${killed.join(",")}），本进程独占`);
  return { killed, skipped: skipped.map((d) => d.pid), remaining: remaining.map((d) => d.pid) };
}
