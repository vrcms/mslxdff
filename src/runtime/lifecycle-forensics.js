// daemon 上一次死亡的验尸官 —— 死亡证明从来不能由死者开：Windows 的关机/TerminateProcess
// 不给被杀进程跑任何 JS 的机会，硬死在遗言层面是零痕迹的（见 crosscut 叶"四种死法"）。
// 所以抓捕靠三方各出一块拼图：
//   ① 杀者留牌：stopDaemon / autostart 清场等"我方所杀"在动手前写 daemon.exit-marker
//      （带死者 pid/版本/意图）——反正 Windows 下被杀者说不出话，牌只能杀者挂；
//   ② 活体信标：daemon 心跳同步写 daemon.alive，钉死"最后一次确证活着"的时刻（死亡窗口下界）；
//   ③ 开机验尸：新进程在 installLifecycleLog（早于 writePid 覆盖 pid 文件）读
//      pid/alive/marker + os.uptime() 回推本机开机时刻，纯函数分桶，结论落 errors.log。
// 分类恒给 diedBetween（死亡窗口）与 detail（中文归因），unknown/reboot/kill 各归各桶，
// 宁可报"不可解释的强杀"也不假装干净。全部 IO 吞异常——验尸失败绝不挡启动。
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";

const SLACK_MS = 15_000; // 时钟/顺序抖动容差：牌的 at 不早于最后心跳−slack 才算"死于本牌"

export function aliveFile(dir) { return join(dir, "daemon.alive"); }
export function markerFile(dir) { return join(dir, "daemon.exit-marker"); }
export function pidPath(dir) { return join(dir, "daemon.pid"); }

function readJsonSafe(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}
function writeJsonSafe(file, obj) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(obj), { mode: 0o600 });
    return true;
  } catch { return false; }
}

/** 活体信标：{pid, version, at, uptimeMs, rssMb}。daemon 模式专属写（debug 前台不碰，防污染死亡窗口）。 */
export function writeAlive(dir, info) { return writeJsonSafe(aliveFile(dir), { at: Date.now(), ...info }); }
export function readAlive(dir) { return readJsonSafe(aliveFile(dir)); }

/** 杀者牌：动手前写，必须自带死者身份（stopDaemon 随后会 unlink pid 文件）。 */
export function writeExitMarker(dir, { reason, prevPid, prevVersion = null, byPid = process.pid, code = null, at } = {}) {
  return writeJsonSafe(markerFile(dir), { reason, prevPid, prevVersion, byPid, code, at: at ?? Date.now() });
}
/** 读后即删：一张牌只许生效一代，防止下代异常死亡被旧牌误导归因。 */
export function consumeExitMarker(dir) {
  const m = readJsonSafe(markerFile(dir));
  try { if (m) unlinkSync(markerFile(dir)); } catch {}
  return m;
}

export function readPidFrom(dir) {
  try {
    const n = Number(String(readFileSync(pidPath(dir), "utf8")).trim().split("\n")[0]);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}
export function readPidVersionFrom(dir) {
  try {
    const l = String(readFileSync(pidPath(dir), "utf8")).split("\n");
    return l.length > 1 && l[1].trim() ? l[1].trim() : null;
  } catch { return null; }
}

/** 开机时刻 = now − 整机 uptime。重启后它是硬事实，任何进程都伪造不了。 */
export function bootTimeMs(now = Date.now()) {
  try { return now - Math.round(os.uptime() * 1000); } catch { return null; }
}

/**
 * 纯函数分桶（可测，不碰 fs）：
 *  none             无前任痕迹（首装 / uninstall 清干净后）
 *  clean-exit       死者自己跑完了 exit 钩子（Linux 信号优雅退出 / process.exit）
 *  killed-by-cli    新鲜杀者牌：via=stop|restart|upgrade|debug-takeover|uninstall|autostart-cleanup…
 *  reboot           无牌，但开机时刻晚于最后信标 → 整机重启带走
 *  holder-alive     旧 pid 仍活（抢端口/接管现场）
 *  unknown          有旧 pid 无信标（早于验尸功能的旧版本残留），死亡窗口给不出
 *  unexplained-kill 机器没重启、无牌、信标戛然而止 → taskkill/任务管理器/硬杀
 */
export function classifyPrevExit({ prevPid = null, prevVersion = null, alive = null, marker = null, bootAtMs = null, now = Date.now(), selfPid = 0, prevStillRunning = false } = {}) {
  const lastAlive = Number.isFinite(alive?.at) ? alive.at : null;
  if (!prevPid && !alive && !marker) return { verdict: "none", detail: "无前任 daemon 痕迹" };
  const freshMarker = marker && Number.isFinite(marker.at) && (lastAlive == null || marker.at >= lastAlive - SLACK_MS);
  if (freshMarker && marker.reason === "process-exit") {
    return { verdict: "clean-exit", prevPid: marker.prevPid ?? prevPid, prevVersion: marker.prevVersion ?? prevVersion, at: marker.at, diedBetween: [lastAlive, marker.at], detail: `前任进程自写遗书正常退出 (pid=${marker.prevPid ?? prevPid} exit code=${marker.code ?? "?"})` };
  }
  if (freshMarker) {
    return { verdict: "killed-by-cli", via: marker.reason, prevPid: marker.prevPid ?? prevPid, prevVersion: marker.prevVersion ?? prevVersion, byPid: marker.byPid ?? null, at: marker.at, diedBetween: [lastAlive, marker.at], detail: `被 CLI/清理方 (pid=${marker.byPid ?? "?"}) 以 ${marker.reason} 名义主动杀死` };
  }
  if (lastAlive != null && bootAtMs != null && bootAtMs > lastAlive + SLACK_MS) {
    return { verdict: "reboot", prevPid, prevVersion, lastAliveAt: lastAlive, bootAt: bootAtMs, diedBetween: [lastAlive, bootAtMs], detail: "死者零遗言，且本机开机时刻晚于最后心跳 → 整机重启带走（Windows 关机不跑 exit 钩子，属预期盲区，靠本桶收口）" };
  }
  if (prevPid && prevStillRunning && prevPid !== selfPid) {
    return { verdict: "holder-alive", prevPid, prevVersion, detail: `旧 pid=${prevPid} 仍在世（抢端口/接管现场，本进程=${selfPid}）` };
  }
  if (lastAlive == null) {
    return { verdict: "unknown", prevPid, prevVersion, detail: "有旧 pid 无活体信标（前任早于验尸功能上线），只能确认已死" };
  }
  return { verdict: "unexplained-kill", prevPid, prevVersion, lastAliveAt: lastAlive, diedBetween: [lastAlive, now], detail: "机器未重启、无杀者牌、信标戛然而止：taskkill/任务管理器/硬杀或断电级崩溃（exit 钩子未跑）" };
}

function defaultIsPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code !== "ESRCH"; }
}

/** 开机验尸入口：读齐三方证据 → 收牌（读后即删）→ 分桶。collect 与 report 一起回，供调用方落日志。 */
export function collectAutopsy({ dir, selfPid = process.pid, now = Date.now(), isPidAliveFn } = {}) {
  const prevPid = readPidFrom(dir);
  const alive = readAlive(dir);
  const input = {
    prevPid,
    prevVersion: readPidVersionFrom(dir),
    alive,
    marker: consumeExitMarker(dir),
    bootAtMs: bootTimeMs(now),
    now,
    selfPid,
    prevStillRunning: !!prevPid && prevPid !== selfPid ? (isPidAliveFn ?? defaultIsPidAlive)(prevPid) : false,
  };
  return { input, report: classifyPrevExit(input) };
}
