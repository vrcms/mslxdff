// 生命周期验尸官回归测试：分类矩阵（纯函数）+ 牌/信标 IO 回路 + collectAutopsy 文件接线。
// 不测 stopDaemon 实杀路径（会 process.kill 真进程）；victim 在世逻辑由 isPidAliveFn 注入覆盖。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyPrevExit, writeAlive, readAlive, writeExitMarker, consumeExitMarker,
  collectAutopsy, markerFile, aliveFile, pidPath, bootTimeMs,
} from "../src/runtime/lifecycle-forensics.js";

const T = 1_790_000_000_000; // 固定"现在"
const dir = () => mkdtempSync(join(tmpdir(), "mslxdff-forensics-"));

test("classify: 无痕迹 → none", () => {
  assert.equal(classifyPrevExit({}).verdict, "none");
});

test("classify: 新鲜 process-exit 牌 → clean-exit", () => {
  const r = classifyPrevExit({ prevPid: 100, alive: { at: T - 60_000 }, marker: { reason: "process-exit", prevPid: 100, code: 0, at: T - 1000 }, now: T, bootAtMs: T - 86400_000 });
  assert.equal(r.verdict, "clean-exit");
  assert.deepEqual(r.diedBetween[1], T - 1000);
});

test("classify: 新鲜杀者牌 → killed-by-cli（带 via/byPid）", () => {
  const r = classifyPrevExit({ prevPid: null, prevVersion: null, alive: { at: T - 60_000 }, marker: { reason: "restart", prevPid: 111, prevVersion: "0.1.160", byPid: 222, at: T - 500 }, now: T, bootAtMs: T - 86400_000 });
  assert.equal(r.verdict, "killed-by-cli");
  assert.equal(r.via, "restart");
  assert.equal(r.prevPid, 111);
  assert.equal(r.byPid, 222);
});

test("classify: 陈牌（早于最后心跳）不作数 → 继续走分桶", () => {
  const r = classifyPrevExit({ prevPid: 333, alive: { at: T - 5_000 }, marker: { reason: "stop", prevPid: 333, at: T - 3_600_000 }, now: T, bootAtMs: T - 86400_000 });
  assert.equal(r.verdict, "unexplained-kill");
});

test("classify: 无牌 + 开机晚于信标 → reboot（本次事故场景）", () => {
  const boot = T - 60_000; // 机器 1 分钟前刚开机
  const r = classifyPrevExit({ prevPid: 444, alive: { at: T - 120_000 }, marker: null, now: T, bootAtMs: boot });
  assert.equal(r.verdict, "reboot");
  assert.deepEqual(r.diedBetween, [T - 120_000, boot]);
});

test("classify: 无牌 + 机器没重启 + 旧 pid 仍在世 → holder-alive", () => {
  const r = classifyPrevExit({ prevPid: 555, alive: { at: T - 30_000 }, marker: null, now: T, bootAtMs: T - 86400_000, selfPid: 1, prevStillRunning: true });
  assert.equal(r.verdict, "holder-alive");
});

test("classify: 无牌 + 没重启 + 已死 → unexplained-kill", () => {
  const r = classifyPrevExit({ prevPid: 666, alive: { at: T - 30_000 }, marker: null, now: T, bootAtMs: T - 86400_000, selfPid: 1, prevStillRunning: false });
  assert.equal(r.verdict, "unexplained-kill");
});

test("classify: 有旧 pid 无信标（功能上线前的旧版本残留）→ unknown", () => {
  const r = classifyPrevExit({ prevPid: 777, alive: null, marker: null, now: T, bootAtMs: T - 86400_000, selfPid: 1 });
  assert.equal(r.verdict, "unknown");
});

test("牌与信标：写读回路 + consume 读后即删", () => {
  const d = dir();
  writeAlive(d, { pid: 42, version: "9.9.9", uptimeMs: 1000, rssMb: 12 });
  const a = readAlive(d);
  assert.equal(a.pid, 42);
  assert.ok(Number.isFinite(a.at));
  writeExitMarker(d, { reason: "stop", prevPid: 42, prevVersion: "9.9.9", byPid: 7 });
  assert.ok(existsSync(markerFile(d)));
  const m = consumeExitMarker(d);
  assert.equal(m.reason, "stop");
  assert.equal(m.prevPid, 42);
  assert.ok(!existsSync(markerFile(d)), "consume 后牌必须被删");
  assert.equal(consumeExitMarker(d), null, "二次 consume 无牌不炸");
});

test("collectAutopsy: 真文件接线 + isPidAliveFn 注入 + 牌被收走", () => {
  const d = dir();
  writeFileSync(pidPath(d), "888\n0.1.160", "utf8");
  const now = Date.now();
  writeAlive(d, { pid: 888, version: "0.1.160" });
  writeFileSync(aliveFile(d), JSON.stringify({ at: now - 20_000 }), "utf8");
  writeExitMarker(d, { reason: "upgrade", prevPid: 888, prevVersion: "0.1.160", byPid: 999, at: now - 1_000 });
  const { input, report } = collectAutopsy({ dir: d, selfPid: 1, now, isPidAliveFn: () => false });
  assert.equal(report.verdict, "killed-by-cli");
  assert.equal(report.via, "upgrade");
  assert.equal(input.prevPid, 888);
  assert.equal(input.prevVersion, "0.1.160");
  assert.ok(!existsSync(markerFile(d)), "验尸收牌");
});

test("collectAutopsy: 本机真实开机时刻可用（reboot 判定不靠注入也自洽）", () => {
  const b = bootTimeMs();
  assert.ok(Number.isFinite(b) && b < Date.now() && b > 1_600_000_000_000, "bootAt 是可信过去时刻");
});
