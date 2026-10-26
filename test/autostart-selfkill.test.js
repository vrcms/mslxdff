// 自杀护栏回归测试 —— bug：Linux 上「裸跑 daemon + autostart 未启用」时 daemon 启动 4~5 秒后
// 被自己 SIGKILL（errors.log 记 unexplained-kill、daemon.alive 停在 uptimeMs:0、user unit 永远
// 停在 disabled）。根因：src/autostart.js 的 linuxEnable() 把**当前进程自己**算成待清理目标
// （pidToWait 补刀 + thread 扫描第二圈 SIGKILL + fuser -k），而这段代码又由 daemon 自己在启动
// 2.5s 后调用。详见 docs/mslxdff-autostart-selfkill-bug.md。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pickBareDaemonPid, partitionKillTargets } from "../src/autostart.js";

const SELF = 4242;

test("pickBareDaemonPid: pid 文件写的是本进程 ⇒ 一律不等、不补刀（护栏①）", () => {
  assert.equal(pickBareDaemonPid(`${SELF}\n0.1.236`, SELF, () => true), null);
  // 即便 isPidAlive 说「活着」也绝不能返回自己
  assert.equal(pickBareDaemonPid(String(SELF), SELF, () => true), null);
});

test("pickBareDaemonPid: 别人的 pid 照常返回（接管裸 daemon 的能力不能丢）", () => {
  assert.equal(pickBareDaemonPid("9999\n0.1.236", SELF, () => true), 9999);
  assert.equal(pickBareDaemonPid("9999", SELF, () => false), null, "进程已死 ⇒ 不用等");
  assert.equal(pickBareDaemonPid("", SELF, () => true), null);
  assert.equal(pickBareDaemonPid("not-a-pid", SELF, () => true), null);
  assert.equal(pickBareDaemonPid("-1", SELF, () => true), null);
});

test("partitionKillTargets: ss 把自己报成端口持有者时，清理目标里绝不能有自己（护栏②）", () => {
  const { targets, selfWasHolder } = partitionKillTargets(new Set([SELF, 1234]), SELF);
  assert.deepEqual(targets, [1234]);
  assert.equal(selfWasHolder, true, "自己是持有者 ⇒ 调用方必须跳过 fuser -k（它按端口无差别杀）");
});

test("partitionKillTargets: 自己没占端口时照常清理别人，且允许 fuser 兜底", () => {
  const { targets, selfWasHolder } = partitionKillTargets([1234, "5678"], SELF);
  assert.deepEqual(targets.sort((a, b) => a - b), [1234, 5678]);
  assert.equal(selfWasHolder, false);
  assert.deepEqual(partitionKillTargets([], SELF), { targets: [], selfWasHolder: false });
});

test("源码级：SIGKILL / fuser / pid 路径三处护栏都在（防后人改回去）", () => {
  const src = readFileSync(new URL("../src/autostart.js", import.meta.url), "utf8");
  assert.match(src, /pidToWait !== process\.pid && isPidAlive\(pidToWait\)/, "pidToWait 等待循环缺 self 判断");
  assert.match(src, /i === 7 && pidToWait !== process\.pid/, "SIGKILL 补刀缺 self 判断");
  assert.match(src, /for \(const p of part\.targets\)/, "SIGKILL 扫描没走剔除 self 后的目标集");
  assert.match(src, /if \(!selfWasHolder\) \{ try \{ await execAsync\("fuser"/, "fuser -k 没做 self 保护");
  assert.match(src, /join\(daemonDir\(\), "daemon\.pid"\)/, "pid 文件必须走 daemonDir()（尊重 MSLXDFF_DAEMON_DIR）");
});

test("daemon 侧：不在自身进程里调 enableAutostart，改由独立 helper 接管", () => {
  const src = readFileSync(new URL("../src/runtime/server-lifecycle.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /await enableAutostart\(\)/, "daemon 内直接调 enableAutostart() = 举手自杀");
  assert.match(src, /repairAutostartOnce\(\{/, "接管由唯一 actor 完成（判据与动作自 ADR-0074 起收在 runtime/autostart-repair.js）");
  const actor = readFileSync(new URL("../src/runtime/autostart-repair.js", import.meta.url), "utf8");
  assert.match(actor, /spawnAutostartHelper\(\)/, "actor 内仍必须派生独立进程完成接管");
  assert.doesNotMatch(actor, /await enableAutostart\(\)/, "actor 里 inline 调 enableAutostart() = 把刚起的 daemon 停掉");
});
