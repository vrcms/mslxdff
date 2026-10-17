// warp-pool · 端口占用与「上一代进程残留」清理（2026-10-16 组长 VPS 真机事故后新增）。
//
// 事故：daemon 被强杀（WMI TerminateProcess / taskkill /F）时 `process.once("exit")` 钩子不执行，
// wireproxy 子进程变成孤儿，继续占着 127.0.0.1:10800+ 这些端口。新 daemon 再起隧道就 bind 失败
// （wireproxy 立刻退出 code=1），而旧代码把「spawn 成功」当成「复活成功」⇒ 无限重启、日志刷屏、
// 且该端口的隧道永远起不来。治本是「起隧道前先把自家残留清掉」，并「端口被别人占着就别硬起」。
import { readFileSync, readdirSync } from "node:fs";
import { connect } from "node:net";
import { nodePaths } from "./nodes.js";

/** /proc/<pid>/cmdline 是 NUL 分隔的字节串；切成参数数组（丢掉结尾空串）。 */
export function parseCmdline(buf) {
  return String(buf == null ? "" : buf).split("\0").filter((s) => s !== "");
}

/**
 * 该进程是不是「正在跑我们这条 conf」的 wireproxy。
 * 判据刻意收紧（argv 里得有 wireproxy 这个可执行文件名，且 conf 路径逐字相等），
 * 免得误杀别人的进程。缺一不可。
 */
export function isOurWireproxy(argv, conf) {
  const list = Array.isArray(argv) ? argv : [];
  const isBin = list.some((a) => /(^|[\\/])wireproxy(\.exe)?$/i.test(a));
  return isBin && list.includes(conf);
}

function defaultPids() {
  try {
    return readdirSync("/proc").filter((f) => /^\d+$/.test(f)).map(Number);
  } catch {
    return [];
  }
}

function defaultCmdline(pid) {
  try {
    return parseCmdline(readFileSync(`/proc/${pid}/cmdline`));
  } catch {
    return [];
  }
}

/** 进程是否还在（信号 0 = 只做存在性检查，不真发信号）。 */
export function pidAlive(pid, kill = process.kill) {
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 清掉「占着该端口那条 conf」的上一代 wireproxy。返回被清理的 pid 列表。
 * 非 Linux 直接返回 []（读不到 /proc，别拿别的平台做危险猜测）。
 * @param {{ dir: string, port: number, log?: Function, platform?: string,
 *           pids?: Function, cmdline?: Function, kill?: Function, sleep?: Function, waitRounds?: number }} opts
 */
export async function reclaimPort({
  dir,
  port,
  log = () => {},
  platform = process.platform,
  pids = defaultPids,
  cmdline = defaultCmdline,
  kill = process.kill,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  waitRounds = 15,
} = {}) {
  if (platform !== "linux") return [];
  const conf = nodePaths(dir, port).conf;
  const targets = pids().filter((pid) => isOurWireproxy(cmdline(pid), conf));
  if (!targets.length) return [];

  log(
    `[warp-pool] 端口 :${port} 发现上一代 wireproxy 残留（pid ${targets.join(", ")}）：` +
      `daemon 被强杀时子进程不会自己退出，它会一直占着端口让新隧道 bind 失败。先清掉再起。`,
  );
  for (const pid of targets) {
    try {
      kill(pid, "SIGTERM");
    } catch {}
  }
  for (let i = 0; i < waitRounds && targets.some((p) => pidAlive(p, kill)); i++) await sleep(100);
  for (const pid of targets.filter((p) => pidAlive(p, kill))) {
    try {
      kill(pid, "SIGKILL");
    } catch {}
  }
  return targets;
}

/** 该端口是否已有人在监听（TCP 连得上 = 占用；连不上/被拒 = 空闲）。 */
export function portInUse(port, { host = "127.0.0.1", timeoutMs = 800, connectFn = connect } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const sock = connectFn({ host, port });
    const finish = (v) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {}
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
  });
}

/**
 * 等端口真正空出来（SIGTERM 之后套接字要几百毫秒才释放，这期间连得上 ≠ 别人的进程占着）。
 * 返回 true = 空了；false = 等了 rounds 轮还是被占。
 */
export async function waitPortFree(port, { inUse = portInUse, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), rounds = 12, stepMs = 250 } = {}) {
  for (let i = 0; i < rounds; i++) {
    if (!(await inUse(port))) return true;
    await sleep(stepMs);
  }
  return !(await inUse(port));
}
