// 进程取证层（Linux /proc 只读）——2026-10-17 组长 VPS「幽灵 daemon 互杀」事故后新增。
//
// 事故：两个 daemon 同时活着（一个从昨天起活了一整天），都管同一批长驻目录（原 warp-pool，已随 ADR-0073 移除），
// 把对方的 wireproxy 当「上一代残留」杀掉 ⇒ 无限互杀、池永远不稳。三处都缺「读 /proc 说事实」的能力：
//   ① 日志不知道「同机还有几个 daemon」（只能靠人肉 ps 才发现）；
//   ② 清理不知道「这个 wireproxy 的父进程还活着（= 另一个 daemon 的活隧道）」；
//   ③ 「SIGKILL 都清不掉」其实是**僵尸**（state=Z，kill 对它无效，但 kill(pid,0) 仍返回成功）。
// 放 runtime 而不是某个子系统目录：daemon 与子系统都要用，放子系统里会让 daemon 反向依赖它。
// 非 Linux 一律返回空 —— 读不到 /proc 就别猜（不在别的平台做危险推断）。
import { readFileSync, readdirSync } from "node:fs";

/** /proc/<pid>/cmdline 是 NUL 分隔的字节串；切成参数数组（丢掉结尾空串）。 */
export function parseCmdline(buf) {
  return String(buf == null ? "" : buf).split("\0").filter((s) => s !== "");
}

/**
 * /proc/<pid>/stat → 我们关心的三格。
 * 格式 `pid (comm) state ppid ... starttime`：comm 里可能有空格和括号 ⇒ 从**最后一个** `)` 之后切，
 * 否则 comm 带括号的进程会让后面所有字段错位。
 * @returns {{state:string, ppid:number, startTicks:number} | null}
 */
export function parseStat(raw) {
  const s = String(raw == null ? "" : raw);
  const cut = s.lastIndexOf(")");
  if (cut < 0) return null;
  const f = s.slice(cut + 1).trim().split(/\s+/);
  if (f.length < 20) return null;
  return { state: String(f[0] || ""), ppid: Number(f[1]) || 0, startTicks: Number(f[19]) || 0 };
}

/** 僵尸：已死、等父进程收尸。kill 对它无效，但 kill(pid, 0) 仍返回成功 ⇒ 必须单独判。 */
export function isZombie(state) {
  return String(state || "").toUpperCase() === "Z";
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

export function defaultPids() {
  try {
    return readdirSync("/proc").filter((f) => /^\d+$/.test(f)).map(Number);
  } catch {
    return [];
  }
}

export function defaultCmdline(pid) {
  try {
    return parseCmdline(readFileSync(`/proc/${pid}/cmdline`));
  } catch {
    return [];
  }
}

export function defaultStat(pid) {
  try {
    return parseStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

/** 本机已开机秒数（/proc/uptime 第一列）；读不到返回 0。 */
export function uptimeSec() {
  try {
    const n = Number(String(readFileSync("/proc/uptime", "utf8")).trim().split(/\s+/)[0]);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** 进程已运行秒数 = 开机秒数 − starttime/USER_HZ（Linux USER_HZ 恒为 100）。取不到返回 null。 */
export function aliveSec(pid, { uptime = uptimeSec, stat = defaultStat } = {}) {
  const st = stat(pid);
  const up = uptime();
  if (!st || !(up > 0) || !(st.startTicks > 0)) return null;
  return Math.max(0, Math.round(up - st.startTicks / 100));
}

/** argv 看起来是我们的 daemon：带 `--daemon`，且有参数以 `mslxdff` / `mslxdff.js` 结尾。 */
export function isDaemonArgv(argv) {
  const list = Array.isArray(argv) ? argv : [];
  return list.includes("--daemon") && list.some((a) => /(^|[\\/])mslxdff(\.js)?$/i.test(String(a)));
}

/**
 * 是否跑在 systemd 托管下（system 或 user unit 都算）。
 * 判据：systemd 给被管服务注入 `INVOCATION_ID`（每个 invocation 唯一）与 `JOURNAL_STREAM`（stdout 连接信息）。
 * 为什么要问：托管时 supervisor 已保证单实例与重启策略，daemon 再自己「杀旧进程/杀端口占用者」是职责重叠，
 * 会与 systemd 的拉起时序打架成死循环（真机 2026-10-19：0.1.209 + 系统 unit 每 2.5s 自杀一轮）。
 * @returns {boolean}
 */
export function underSystemd(env = process.env) {
  return Boolean(env.INVOCATION_ID || env.JOURNAL_STREAM);
}

/** 「已运行 6h12m」这种人话时长（取证日志用）。 */
export function fmtAlive(sec) {
  if (!Number.isFinite(sec)) return "运行时长未知";
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

/**
 * 同机其它我们的 daemon（排除 self）。
 * 「不在 daemon.pid 里的 daemon」是 `-restart` 的结构性盲区 —— 必须能列出来，才谈得上清理与告警。
 * @returns {Array<{pid:number, ppid:number, state:string, aliveSec:number|null}>}
 */
export function findDaemons({ self = 0, pids = defaultPids, cmdline = defaultCmdline, stat = defaultStat, uptime = uptimeSec } = {}) {
  const out = [];
  for (const pid of pids()) {
    if (pid === self) continue;
    if (!isDaemonArgv(cmdline(pid))) continue;
    const st = stat(pid);
    out.push({
      pid,
      ppid: st ? st.ppid : 0,
      state: st ? st.state : "",
      aliveSec: aliveSec(pid, { uptime, stat: () => st }),
    });
  }
  return out;
}

/**
 * 该进程的父进程是不是**另一个活着的 mslxdff daemon**？
 * 是 ⇒ 这不是「上一代残留」，是**别人的活隧道**（清了就是互杀）。
 * 自家子进程（ppid=self）、孤儿（ppid<=1 或父进程已死）、读不到 stat 都返回 null（照旧清）。
 * @returns {{pid:number, aliveSec:number|null} | null}
 */
export function otherDaemonParent(pid, { self = process.pid, stat = defaultStat, cmdline = defaultCmdline, kill = process.kill, uptime = uptimeSec } = {}) {
  const st = stat(pid);
  if (!st || st.ppid <= 1 || st.ppid === self) return null;
  if (!pidAlive(st.ppid, kill)) return null;
  if (!isDaemonArgv(cmdline(st.ppid))) return null;
  return { pid: st.ppid, aliveSec: aliveSec(st.ppid, { uptime, stat }) };
}
