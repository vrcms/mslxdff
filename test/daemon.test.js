import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pidFile, logFile, writePid, readPid, readPidVersion, isPidAlive, stopDaemon, startDaemon, daemonDir } from "../src/daemon.js";
import { markerFile } from "../src/runtime/lifecycle-forensics.js";

const DIR = mkdtempSync(join(tmpdir(), "mslxdff-daemon-"));

process.env.MSLXDFF_DAEMON_DIR = DIR;
process.env.MSLXDFF_STATE_FILE = join(DIR, "state.json");

test("pidFile and logFile live under daemon dir", () => {
  assert.equal(pidFile(), join(DIR, "daemon.pid"));
  assert.equal(logFile(), join(DIR, "daemon.log"));
});

test("writePid/readPid round-trips", () => {
  writePid(12345);
  assert.equal(readPid(), 12345);
});

test("writePid with version and readPidVersion round-trips", () => {
  writePid(23456, "0.2.0");
  assert.equal(readPid(), 23456);
  assert.equal(readPidVersion(), "0.2.0");
});

test("legacy pid files (number only) still resolve with null version", () => {
  writePid(34567);
  assert.equal(readPid(), 34567);
  assert.equal(readPidVersion(), null);
});

test("isPidAlive detects a running process and a dead pid", () => {
  // this very test process is alive
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(2_147_483_647), false);
});

test("stopDaemon returns stopped:false when no pid", () => {
  const f = pidFile();
  try {
    unlinkSync(f);
  } catch {}
  const r = stopDaemon();
  assert.equal(r.stopped, false);
});

// BUG-28：杀失败（EPERM 且 taskkill 也没成）时原代码**照样删 pid 文件**，于是这个仍在监听端口的
// daemon 从台账里消失：下次 readPid() 返回 null ⇒ -stop 打印「not running」、-restart 直接起新的与它抢端口，
// 而它其实一直在跑 —— 正是 daemon.js 注释里记的「不在册的幽灵 daemon，-restart 结构性盲区」。
// 同时杀者牌（exit-marker）是「我杀成了」的声明，留着会让下次启动把**在世的**它验成 killed-by-cli。
test("stopDaemon 杀失败时必须保留 pid 文件、并撤掉杀者牌", () => {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-stopperr-"));
  const prevDir = process.env.MSLXDFF_DAEMON_DIR;
  process.env.MSLXDFF_DAEMON_DIR = dir;
  try {
    // 用一个「非本进程」的 pid（否则会先撞上自杀护栏，测不到这一支）
    writePid(999_999);
    const eperm = () => { const e = new Error("EPERM"); e.code = "EPERM"; throw e; };
    const r = stopDaemon({
      reason: "test",
      kill: eperm,
      isAlive: () => true, // 目标活着 ⇒ victimAlive 为真、才会写牌
      taskkill: () => ({ error: null, status: 1 }), // taskkill 也失败
    });
    assert.equal(r.stopped, false);
    assert.equal(r.pid, 999_999);
    assert.equal(existsSync(pidFile()), true, "进程还活着，pid 文件不得删除（否则变成 -restart 盲区）");
    assert.equal(readPid(), 999_999, "台账必须还认得它");
    assert.equal(existsSync(markerFile(dir)), false, "没杀成就不能留杀者牌（会开出假死亡证明）");
  } finally {
    process.env.MSLXDFF_DAEMON_DIR = prevDir;
  }
});

test("stopDaemon taskkill 兜底成功时仍按杀成功处理：删 pid 文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-stopok-"));
  const prevDir = process.env.MSLXDFF_DAEMON_DIR;
  process.env.MSLXDFF_DAEMON_DIR = dir;
  try {
    writePid(999_999); // 同样避开自杀护栏
    const eperm = () => { const e = new Error("EPERM"); e.code = "EPERM"; throw e; };
    const r = stopDaemon({ reason: "test", kill: eperm, isAlive: () => true, taskkill: () => ({ error: null, status: 0 }) });
    assert.equal(r.stopped, true);
    assert.equal(existsSync(pidFile()), false, "杀成功才删 pid 文件");
  } finally {
    process.env.MSLXDFF_DAEMON_DIR = prevDir;
  }
});

// 2026-10-19 真机：0.1.209 + systemd **系统** unit 下每 2.5s 自杀一轮无限重启。
// 链条＝daemon 自己 writePid(process.pid)，server-lifecycle 的 autostart 自检在系统 unit 下查 user unit
// 必判「未启用」⇒ linuxEnable() ⇒ stopDaemon() ⇒ 读到的 pid 就是自己 ⇒ SIGTERM 自己 ⇒ exit 0 ⇒ systemd 拉起。
// 护栏：pid 文件指向本进程时一律拒绝，绝不自杀。
test("stopDaemon 自杀护栏：pid 文件写的是本进程时拒绝，一个信号都不发（治 systemd 无限重启）", () => {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-stopself-"));
  const prevDir = process.env.MSLXDFF_DAEMON_DIR;
  process.env.MSLXDFF_DAEMON_DIR = dir;
  try {
    writePid(process.pid);
    const sigs = [];
    const r = stopDaemon({ reason: "test", kill: (pid, sig) => sigs.push([pid, sig]) });
    assert.equal(r.stopped, false);
    assert.equal(r.pid, process.pid);
    assert.equal(sigs.length, 0, "不许对自己发任何信号（发 SIGTERM 就是优雅关停 → 无限重启）");
    assert.match(String(r.reason), /self/, "理由须说明是自指");
    assert.equal(existsSync(pidFile()), true, "pid 文件必须留着（我们没停任何人）");
  } finally {
    process.env.MSLXDFF_DAEMON_DIR = prevDir;
  }
});

test("startDaemon spawns a detached child and stopDaemon kills it", async () => {
  process.env.MSLXDFF_PORT = "0";
  const pid = startDaemon([]);
  assert.ok(pid > 0);
  // poll for the pid file to appear (child writes it after server ready)
  for (let i = 0; i < 20; i++) {
    if (readPid()) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(readPid(), pid);
  const stopped = stopDaemon();
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.pid, pid);
});