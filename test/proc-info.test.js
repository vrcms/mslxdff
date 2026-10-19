// /proc 取证层 + 「幽灵 daemon」收口逻辑的离线测试（纯解析 + 全部注入，不依赖 Linux、不真发信号）。
// 背景（2026-10-17 组长 VPS 真机事故）：两个 daemon 同时活着，都管同一份 warp-pool 目录，
// 互相把对方的活隧道当「上一代残留」杀掉 ⇒ 无限互杀。这三件事必须可测，否则下次还得靠人肉 ps 才发现。
import { test } from "node:test";
import assert from "node:assert/strict";
import { aliveSec, findDaemons, fmtAlive, isDaemonArgv, isZombie, otherDaemonParent, parseCmdline, parseStat, underSystemd } from "../src/runtime/proc-info.js";
import { reapGhostDaemons, takeoverOlderDaemons, waitPidGone } from "../src/daemon.js";

test("proc：parseStat 从最后一个 ')' 之后切（comm 带空格/括号也不许错位）", () => {
  const raw = "1234 (node (x) y) S 1 1234 1234 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 987654 0 0";
  const st = parseStat(raw);
  assert.equal(st.state, "S");
  assert.equal(st.ppid, 1);
  assert.equal(st.startTicks, 987654);
  assert.equal(parseStat("garbage"), null);
  assert.equal(parseStat("1 (x) S 1"), null, "字段不够不许硬解");
  assert.equal(parseStat(null), null);
});

test("proc：parseCmdline 切 NUL 分隔的 /proc/<pid>/cmdline", () => {
  assert.deepEqual(parseCmdline("wireproxy\0-c\0/a/node-1.conf\0"), ["wireproxy", "-c", "/a/node-1.conf"]);
  assert.deepEqual(parseCmdline(""), []);
  assert.deepEqual(parseCmdline(null), []);
});

test("proc：僵尸（Z）必须单独判——kill 对它无效，但 kill(pid,0) 仍返回成功", () => {
  assert.equal(isZombie("Z"), true);
  assert.equal(isZombie("z"), true);
  assert.equal(isZombie("S"), false);
  assert.equal(isZombie(""), false);
  assert.equal(isZombie(null), false);
});

test("proc：aliveSec = 开机秒数 − starttime/USER_HZ；取不到给 null，不许瞎猜", () => {
  const stat = () => ({ state: "S", ppid: 1, startTicks: 6100 });
  assert.equal(aliveSec(7, { uptime: () => 3600, stat }), 3539);
  assert.equal(aliveSec(7, { uptime: () => 0, stat }), null, "读不到开机时长 ⇒ 不猜");
  assert.equal(aliveSec(7, { uptime: () => 3600, stat: () => null }), null, "读不到 stat ⇒ 不猜");
  assert.equal(fmtAlive(22320), "6h12m");
  assert.equal(fmtAlive(90), "1m");
  assert.equal(fmtAlive(9), "9s");
  assert.equal(fmtAlive(null), "运行时长未知");
});

test("proc：isDaemonArgv 只认「我们的入口 + --daemon」，grep 与别的 node 进程不许命中", () => {
  assert.equal(isDaemonArgv(["/usr/bin/node", "/usr/lib/node_modules/mslxdff/bin/mslxdff.js", "--daemon"]), true);
  assert.equal(isDaemonArgv(["/usr/bin/node", "D:/x/mslxdff/bin/mslxdff.js", "--daemon"]), true);
  assert.equal(isDaemonArgv(["/usr/bin/node", "/x/mslxdff.js"]), false, "没有 --daemon 不算 daemon");
  assert.equal(isDaemonArgv(["grep", "--color=auto", "mslxdff"]), false, "ps 里那条 grep 不许被当成 daemon");
  assert.equal(isDaemonArgv(["/usr/bin/node", "/x/other.js", "--daemon"]), false);
  assert.equal(isDaemonArgv(null), false);
});

test("proc：underSystemd 只认 systemd 注入的 INVOCATION_ID / JOURNAL_STREAM", () => {
  assert.equal(underSystemd({ INVOCATION_ID: "abc123" }), true, "systemd 系统/用户 unit 都会注入 INVOCATION_ID");
  assert.equal(underSystemd({ JOURNAL_STREAM: "9:12345" }), true, "JOURNAL_STREAM 也是判据（stdout 接 journal 时）");
  assert.equal(underSystemd({ INVOCATION_ID: "", JOURNAL_STREAM: "" }), false, "空串不算");
  assert.equal(underSystemd({}), false, "裸跑/手动启动没有这些变量");
  assert.equal(underSystemd({ PATH: "/usr/bin" }), false);
});

test("proc：findDaemons 列出同机其它 daemon 并排除 self（-restart 的结构性盲区就在这）", () => {
  const argv = {
    10: ["/usr/bin/node", "/g/mslxdff/bin/mslxdff.js", "--daemon"],
    11: ["grep", "mslxdff"],
    12: ["/usr/bin/node", "/g/mslxdff/bin/mslxdff.js", "--daemon"],
  };
  const st = { 10: { state: "S", ppid: 1, startTicks: 0 }, 12: { state: "S", ppid: 1, startTicks: 6100 } };
  const list = findDaemons({ self: 12, pids: () => [10, 11, 12], cmdline: (p) => argv[p], stat: (p) => st[p], uptime: () => 3600 });
  assert.deepEqual(list.map((d) => d.pid), [10], "排除 self，grep 不算 daemon");
  assert.equal(list[0].ppid, 1);
  assert.equal(list[0].aliveSec, null, "startTicks=0 取不到运行时长 ⇒ 给 null 而不是编一个");
});

test("proc：otherDaemonParent 只对「父进程是另一个活 daemon」认账（自家子进程/孤儿/死父都不算）", () => {
  const argv = { 999: ["/usr/bin/node", "/g/mslxdff/bin/mslxdff.js", "--daemon"], 5: ["bash"] };
  const live = new Set([999, 5]);
  const kill = (pid, sig) => {
    if (sig === 0 && !live.has(pid)) throw new Error("gone");
  };
  const mk = (ppid) => ({ state: "S", ppid, startTicks: 0 });
  const stats = { 21: mk(999), 22: mk(1), 23: mk(5), 24: mk(777) };
  const o = (pid, self = 1) => otherDaemonParent(pid, { self, stat: (p) => stats[p], cmdline: (p) => argv[p], kill, uptime: () => 0 });
  assert.deepEqual(o(21), { pid: 999, aliveSec: null }, "父进程是活着的 daemon ⇒ 别人的活隧道");
  assert.equal(o(22), null, "ppid=1 = 真孤儿 ⇒ 照旧清");
  assert.equal(o(23), null, "父进程活着但不是 daemon（bash）⇒ 不算别人的活隧道");
  assert.equal(o(24), null, "父进程 777 已死 ⇒ 孤儿，照旧清");
  assert.equal(o(21, 999), null, "父进程就是自己（自家丢引用的子进程）⇒ 照旧清");
});

test("daemon：waitPidGone 等到自然退出就不补刀；退不掉才 SIGKILL，且诚实报「没死」", async () => {
  const seq = [true, true, false];
  let i = 0;
  const r = await waitPidGone(5, {
    isAlive: () => seq[Math.min(i++, seq.length - 1)],
    sleep: async () => {},
    kill: () => {
      throw new Error("不该补刀");
    },
  });
  assert.equal(r.died, true);
  assert.equal(r.forced, false);

  const sigs = [];
  const r2 = await waitPidGone(6, { isAlive: () => true, sleep: async () => {}, kill: (pid, sig) => sigs.push([pid, sig]), timeoutMs: 1, killWaitMs: 1 });
  assert.equal(r2.forced, true);
  assert.deepEqual(sigs, [[6, "SIGKILL"]]);
  assert.equal(r2.died, false, "SIGKILL 之后还在世 ⇒ 诚实报没死（不许谎报「已停」）");
});

test("daemon：reapGhostDaemons 清掉「不在册」的 daemon 并返回确实清掉的清单（-restart 的盲区收口）", async () => {
  const logs = [];
  const alive = new Set([41, 42]);
  const sigs = [];
  const kill = (pid, sig) => {
    sigs.push([pid, sig]);
    if (sig === "SIGKILL") alive.delete(pid);
    else if (pid === 41) alive.delete(pid); // 41 听 SIGTERM；42 装死，必须补刀
  };
  const gone = await reapGhostDaemons({
    list: () => [{ pid: 41, ppid: 1, aliveSec: 100 }, { pid: 42, ppid: 1, aliveSec: 22320 }],
    kill,
    isAlive: (pid) => alive.has(pid),
    sleep: async () => {},
    settleMs: 1,
    killWaitMs: 1,
    log: (m) => logs.push(m),
  });
  assert.deepEqual(gone.map((g) => g.pid).sort((a, b) => a - b), [41, 42], "两个都得清掉");
  assert.ok(sigs.some(([p, s]) => p === 42 && s === "SIGKILL"), "42 不听 SIGTERM ⇒ 必须补 SIGKILL");
  assert.ok(logs.some((l) => l.includes("不在册的 daemon pid=41") && l.includes("已运行 1m")), "必须报出是哪个 pid、已运行多久");
  assert.deepEqual(await reapGhostDaemons({ list: () => [], log: () => {} }), [], "没有幽灵就别刷日志");
});

test("daemon：takeoverOlderDaemons 启动时先请走「比我们旧」的 daemon（内存里有 mslxdff 就先让旧的退出）", async () => {
  const logs = [];
  const live = new Set([71, 72, 73]);
  const sigs = [];
  const kill = (pid, sig) => {
    sigs.push([pid, sig]);
    if (sig === "SIGKILL") live.delete(pid);
    else if (pid === 71) live.delete(pid); // 71 听 SIGTERM；72 装死要补刀；73 是同期启动，不该被碰
  };
  const r = await takeoverOlderDaemons({
    self: 99,
    myAliveSec: 2,
    list: () => [
      { pid: 71, ppid: 1, aliveSec: 22320 },
      { pid: 72, ppid: 1, aliveSec: 3600 },
      { pid: 73, ppid: 1, aliveSec: 3 },
    ],
    kill,
    isAlive: (pid) => live.has(pid),
    sleep: async () => {},
    settleMs: 1,
    killWaitMs: 1,
    log: (m) => logs.push(m),
  });
  assert.deepEqual(r.killed.slice().sort((a, b) => a - b), [71, 72], "比我们旧的两个都要请走");
  assert.deepEqual(r.skipped, [73], "与本次启动几乎同时的不动（避免两边互杀）");
  assert.deepEqual(r.remaining, []);
  assert.ok(sigs.some(([p, s]) => p === 72 && s === "SIGKILL"), "72 不听 SIGTERM ⇒ 必须补 SIGKILL");
  assert.ok(logs.some((l) => l.includes("pid 71") && l.includes("已运行 6h12m") && l.includes("比本进程旧")), "必须报出是哪个 pid、已运行多久");
  assert.ok(logs.some((l) => l.includes("已请走 2 个旧 daemon")), "清完要报结论");
  assert.ok(logs.some((l) => l.includes("pid 73") && l.includes("几乎同时")), "同期启动的要说明为什么不动它");
});

test("daemon：takeoverOlderDaemons 请不走时诚实报出（僵尸/权限）；没有兄弟就不刷日志", async () => {
  const logs = [];
  const r = await takeoverOlderDaemons({
    self: 99,
    myAliveSec: 2,
    list: () => [{ pid: 81, ppid: 1, aliveSec: 9999 }],
    kill: () => {},
    isAlive: () => true,
    sleep: async () => {},
    settleMs: 1,
    killWaitMs: 1,
    log: (m) => logs.push(m),
  });
  assert.deepEqual(r.remaining, [81]);
  assert.deepEqual(r.killed, []);
  assert.ok(logs.some((l) => l.includes("请不走：pid 81") && l.includes("kill -9")), "请不走必须诚实报出并给出手动命令");
  const quiet = await takeoverOlderDaemons({ list: () => [], log: () => { throw new Error("没有兄弟就不该打日志"); } });
  assert.deepEqual(quiet, { killed: [], skipped: [], remaining: [] });
});
