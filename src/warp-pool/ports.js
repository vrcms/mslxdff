// warp-pool · 端口占用与「上一代进程残留」清理（2026-10-16 真机事故后新增；2026-10-17 七次修订）。
//
// 事故一（0.1.179）：daemon 被强杀时 `process.once("exit")` 钩子不执行，wireproxy 子进程变孤儿继续占着端口。
// 事故二（七次修订，真机铁证）：**两个 daemon 同时活着**（一个从昨天起活了一整天），两者都用同一份
//   `node-<port>.conf` 判「本池残留」⇒ 互相把对方的**活隧道**当残留杀掉 ⇒ 无限互杀、池永远不稳。
// 两条教训写进判据：
//   ① 父进程是**另一个活着的 daemon** ⇒ 那不是残留，是「别人的活隧道」，清了就是互杀 ⇒ 不许清，只报出来；
//   ② 「SIGKILL 都清不掉」多半是**僵尸**（state=Z：kill 无效，但 kill(pid,0) 仍返回成功）⇒ 僵尸算已死。
import { connect } from "node:net";
import { defaultCmdline, defaultPids, defaultStat, isZombie, otherDaemonParent, parseCmdline, pidAlive } from "../runtime/proc-info.js";
import { nodePaths } from "./nodes.js";
import { fmtReclaim } from "./report.js";

// /proc 读取层已上移到 runtime/proc-info.js（daemon 侧也要用同一套判据）；这里原样再导出，既有调用方路径不变。
export { parseCmdline, pidAlive };

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

/**
 * 清掉占着该端口那条 conf 的**真残留**：自家丢引用的子进程、父进程已死的孤儿。
 * 不动的三类：僵尸（kill 无效，也不是真占用者）、**父进程是另一个活 daemon 的活隧道**（清了就是互杀）、
 * argv 不匹配的别人的进程。
 * 非 Linux 直接返回空（读不到 /proc，别拿别的平台做危险猜测）。
 * @returns {Promise<{scanned:number, killed:number[], zombies:number[],
 *           foreign:Array<{pid:number,ppid:number,aliveSec:number|null}>, waitedMs:number, gone:boolean}>}
 */
export async function reclaimPort({
  dir,
  port,
  log = () => {},
  platform = process.platform,
  pids = defaultPids,
  cmdline = defaultCmdline,
  stat = defaultStat,
  kill = process.kill,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  waitRounds = 15,
} = {}) {
  const startedAt = Date.now();
  const shape = (scanned, killed, zombies, foreign) => ({
    scanned,
    killed,
    zombies,
    foreign,
    waitedMs: Date.now() - startedAt,
    gone: !killed.some((p) => pidAlive(p, kill)),
  });
  if (platform !== "linux") return shape(0, [], [], []);

  const conf = nodePaths(dir, port).conf;
  const all = pids();
  const zombies = [];
  const foreign = [];
  const targets = [];
  for (const pid of all) {
    if (!isOurWireproxy(cmdline(pid), conf)) continue;
    const st = stat(pid);
    if (st && isZombie(st.state)) {
      zombies.push(pid);
      continue;
    }
    const other = otherDaemonParent(pid, { stat, cmdline, kill });
    if (other) {
      foreign.push({ pid, ppid: other.pid, aliveSec: other.aliveSec });
      continue;
    }
    targets.push(pid);
  }

  if (targets.length) {
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
  }
  const r = shape(all.length, targets, zombies, foreign);
  log(fmtReclaim({ port, ...r }));
  return r;
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

/**
 * 端口占用者取证：谁在监听——本池残留？另一个 daemon 的活隧道？僵尸？别人的进程？还是空闲。
 * 「孤儿占端口」「两个 daemon 互杀」这两类事故唯一能一眼看出结论的读数：只报「占用 / 拒绝再起」是查不出问题的。
 * @returns {Promise<{busy:boolean, ours:number[], zombies:number[],
 *           foreign:Array<{pid:number,ppid:number,aliveSec:number|null}>, others:Array<{pid:number,name:string}>}>}
 */
export async function portOwner({ dir, port, platform = process.platform, pids = defaultPids, cmdline = defaultCmdline, stat = defaultStat, kill = process.kill, inUse = portInUse } = {}) {
  const busy = await inUse(port);
  const out = { busy, ours: [], zombies: [], foreign: [], others: [] };
  if (!busy || platform !== "linux") return out;
  const conf = nodePaths(dir, port).conf;
  for (const pid of pids()) {
    const argv = cmdline(pid);
    if (!argv.length) continue;
    if (isOurWireproxy(argv, conf)) {
      const st = stat(pid);
      if (st && isZombie(st.state)) {
        out.zombies.push(pid);
        continue;
      }
      const other = otherDaemonParent(pid, { stat, cmdline, kill });
      if (other) {
        out.foreign.push({ pid, ppid: other.pid, aliveSec: other.aliveSec });
        continue;
      }
      out.ours.push(pid);
      continue;
    }
    // 非 root 看不到别人的 listen 表，退一步：命令行里带着这个端口号的进程也值得报出来
    if (argv.some((a) => String(a).includes(`:${port}`))) out.others.push({ pid, name: String(argv[0]).split("/").pop() });
  }
  return out;
}
