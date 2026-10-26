// 开机自启「自愈」回归测试。三条真机事实，一条都不能再退回去：
// 1) 2026-10-26 真机：这台 Windows 的自启注册被清得四处全空（schtasks / HKCU Run /
//    启动文件夹 / WMI StartupCommand），而 Windows 分支没有 systemd `Restart=always` 兜底，
//    daemon 又从不补注册（唯一的自愈块写死 `process.platform === "linux"`）⇒ 永久静默失效。
// 2) 老判据只问「注册项在不在」：npm 换 prefix、仓库目录搬家、删掉全局包留个死键这三种情况
//    下 `-status` 照样印「已启用」，开机却什么都起不来 ⇒ 体检必须核对注册内容里的路径。
// 3) 自愈动作必须由独立 helper 进程做：`enableAutostart()` 在 Linux 的语义是「停掉裸 daemon、
//    把端口让给 systemd」，daemon 自己调 = 举手自杀（0.1.236 真机，见 autostart-selfkill.test.js）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractRegisteredPaths, assessRegistrationHealth } from "../src/autostart.js";
import { repairAutostartOnce, autostartRepairEnabled, REPAIR_INFLIGHT_MS } from "../src/runtime/autostart-repair.js";
import {
  AUTOSTART_REPAIR_MAX_FAILS,
  loadAutostartWanted,
  saveAutostartWanted,
  loadAutostartRepair,
  recordAutostartRepair,
  markAutostartRepairAttempt,
  autostartRepairBudget,
} from "../src/state/schemas/autostart.js";

const existsAll = () => true;
const existsNone = () => false;

test("extractRegisteredPaths: Windows 混排（带空格路径加引号 + 裸脚本）两条都要认出来", () => {
  const got = extractRegisteredPaths('"C:\\Program Files\\nodejs\\node.exe" "D:\\www\\mslxdff\\bin\\mslxdff.js"');
  assert.deepEqual(got, ["C:\\Program Files\\nodejs\\node.exe", "D:\\www\\mslxdff\\bin\\mslxdff.js"]);
  // 只引号一半（schtasks 的 Task To Run 常这么吐）：裸 token 也不能漏
  assert.deepEqual(
    extractRegisteredPaths('"C:\\Program Files\\nodejs\\node.exe" D:\\www\\mslxdff\\bin\\mslxdff.js'),
    ["C:\\Program Files\\nodejs\\node.exe", "D:\\www\\mslxdff\\bin\\mslxdff.js"]
  );
});

test("extractRegisteredPaths: Linux ExecStart 认 node+脚本，且绝不把 --daemon 当路径", () => {
  const got = extractRegisteredPaths("/usr/bin/node /home/u/app/bin/mslxdff.js --daemon");
  assert.deepEqual(got, ["/usr/bin/node", "/home/u/app/bin/mslxdff.js"]);
  assert.deepEqual(extractRegisteredPaths(""), []);
  assert.deepEqual(extractRegisteredPaths("mslxdff"), []); // 无路径特征 = 服务名，不算路径
});

test("assessRegistrationHealth: 没注册 = 失效（Windows 与 Linux 各给一句能看懂的原因）", () => {
  const w = assessRegistrationHealth({ status: { enabled: false }, exists: existsAll, platform: "win32" });
  assert.equal(w.ok, false);
  assert.match(w.reason, /未注册/);
  const l = assessRegistrationHealth({ status: { enabled: false }, exists: existsAll, platform: "linux" });
  assert.equal(l.ok, false);
  assert.match(l.reason, /systemd|unit/i);
});

test("assessRegistrationHealth: 注册在但里面的路径已不存在 ⇒ 判失效并点名缺哪条（真机第 2 条）", () => {
  const h = assessRegistrationHealth({
    status: { enabled: true, taskToRun: '"C:\\Program Files\\nodejs\\node.exe" "D:\\gone\\bin\\mslxdff.js"' },
    exists: (p) => !p.includes("gone"),
    platform: "win32",
  });
  assert.equal(h.ok, false);
  assert.deepEqual(h.missing, ["D:\\gone\\bin\\mslxdff.js"]);
  assert.match(h.reason, /已不存在/);
});

test("assessRegistrationHealth: 路径都在 ⇒ 通过；Linux 走 execStart 同一条判据", () => {
  assert.equal(assessRegistrationHealth({
    status: { enabled: true, taskToRun: '"C:\\n\\node.exe" "D:\\a\\mslxdff.js"' },
    exists: existsAll, platform: "win32",
  }).ok, true);
  const linux = assessRegistrationHealth({
    status: { enabled: true, execStart: "/usr/bin/node /home/u/app/bin/mslxdff.js --daemon" },
    exists: existsNone, platform: "linux",
  });
  assert.equal(linux.ok, false, "exists 全 false ⇒ Linux 侧也必须判失效（判据同源）");
  assert.equal(assessRegistrationHealth({
    status: { enabled: true, execStart: "/usr/bin/node /home/u/app/bin/mslxdff.js --daemon" },
    exists: existsAll, platform: "linux",
  }).ok, true);
});

test("assessRegistrationHealth: 任务被禁用 = 失效；解析不出路径时**不判死**（无凭据不误杀）", () => {
  assert.equal(assessRegistrationHealth({
    status: { enabled: true, taskStatus: "Disabled", taskToRun: '"C:\\n\\node.exe" "D:\\a\\mslxdff.js"' },
    exists: existsAll, platform: "win32",
  }).ok, false);
  const unknown = assessRegistrationHealth({
    status: { enabled: true, taskToRun: "some-weird-runner mslxdff" },
    exists: existsNone, platform: "win32",
  });
  assert.equal(unknown.ok, true, "认不出路径 ⇒ 不能判失效，否则每轮启动白派一个 helper");
  assert.equal(unknown.unknown, true);
});

test("意愿位缺省 = 要自启；只有显式 -disable 写成 false 才不再补", () => {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-test-autostart-"));
  const file = join(dir, "state.json");
  try {
    assert.equal(loadAutostartWanted({ file }), true, "老 state 没这个键 ⇒ 默认要开机自启");
    assert.equal(saveAutostartWanted(false, { file }), false);
    assert.equal(loadAutostartWanted({ file }), false);
    saveAutostartWanted(true, { file });
    assert.equal(loadAutostartWanted({ file }), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("重注入台账：失败累加、成功清零、预算耗尽后不再 fork（受限环境不反复白派进程）", () => {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-test-autostart-"));
  const file = join(dir, "state.json");
  try {
    assert.deepEqual(loadAutostartRepair({ file }), { fails: 0, at: 0, reason: "" });
    assert.equal(autostartRepairBudget({ file }), AUTOSTART_REPAIR_MAX_FAILS);
    for (let i = 1; i <= AUTOSTART_REPAIR_MAX_FAILS; i++) {
      const rep = recordAutostartRepair({ ok: false, reason: `拒绝访问 ${i}`, file });
      assert.equal(rep.fails, i);
      assert.equal(autostartRepairBudget({ file }), AUTOSTART_REPAIR_MAX_FAILS - i);
    }
    assert.equal(autostartRepairBudget({ file }), 0, "三次全失败 ⇒ 预算归零，daemon 只该告警");
    recordAutostartRepair({ ok: true, file });
    assert.equal(autostartRepairBudget({ file }), AUTOSTART_REPAIR_MAX_FAILS, "一旦注入成功必须清零");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("脏台账（人为改坏的 state）按「没失败过」处理，绝不因脏值停掉自愈", () => {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-test-autostart-"));
  const file = join(dir, "state.json");
  try {
    writeFileSync(file, JSON.stringify({ autostartRepair: { fails: "很多", at: null, reason: 123 } }));
    assert.deepEqual(loadAutostartRepair({ file }), { fails: 0, at: 0, reason: "123" });
    assert.equal(autostartRepairBudget({ file }), AUTOSTART_REPAIR_MAX_FAILS);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("源码级：自愈不再 Linux 独占，判据与动作收在唯一 actor，两个调用方都调它（防改回去）", () => {
  const actor = readFileSync(new URL("../src/runtime/autostart-repair.js", import.meta.url), "utf8");
  assert.match(actor, /platform !== "win32" && platform !== "linux"/, "自愈必须覆盖 Windows 与 Linux（macOS 排除）");
  assert.match(actor, /checkAutostartHealth/, "走统一体检（内容健康+预算+supervised），不能退回只看 enabled");
  assert.match(actor, /if \(!h\.wanted\)/, "用户明确 -disable 过 ⇒ 绝不擅自补注册");
  assert.match(actor, /h\.budget <= 0/, "预算耗尽 ⇒ 只告警不再 fork");
  assert.match(actor, /since < inflightMs/, "在途互斥 ⇒ restart 与 daemon 启动不连派两个 helper");
  assert.match(actor, /REPAIR_INFLIGHT_MS/, "在途窗口是具名常量，不许散落魔法数");
  assert.doesNotMatch(actor, /await enableAutostart\(\)/, "actor 里直接调 enableAutostart() = 把刚起的 daemon 停掉");
  assert.match(actor, /"-enable-autostart"/, "注入动作仍由独立 helper 进程做（ADR-0069）");
  const sl = readFileSync(new URL("../src/runtime/server-lifecycle.js", import.meta.url), "utf8");
  assert.match(sl, /repairAutostartOnce\(\{/, "daemon 启动自愈必须调同一个 actor");
  assert.doesNotMatch(sl, /await enableAutostart\(\)/, "daemon 内直接调 enableAutostart() = 举手自杀");
});

test("源码级：Windows/Linux 两条 status 都吐出可核对内容，且面板与自愈同一判据", () => {
  const src = readFileSync(new URL("../src/autostart.js", import.meta.url), "utf8");
  assert.match(src, /taskStatus: m \? m\[1\]\.trim\(\) : ""/, "winStatus 要带任务状态（禁用态得能被体检发现）");
  assert.match(src, /method: "schtasks"/, "winStatus 要标明注册来源");
  assert.match(src, /unit, execStart \}/, "linuxStatus 要吐 ExecStart（路径核对靠它）");
  const status = readFileSync(new URL("../src/cli/status.js", import.meta.url), "utf8");
  assert.match(status, /checkAutostartHealth\(\)/, "-status 面板必须与自愈共用同一判据，不许两套真相");
  const cli = readFileSync(new URL("../src/cli/commands/system.js", import.meta.url), "utf8");
  assert.match(cli, /saveAutostartWanted\(true\)/, "enable 成功要落意愿位");
  assert.match(cli, /saveAutostartWanted\(false\)/, "disable 成功要落意愿位（否则自愈会跟用户对着干）");
  assert.match(cli, /recordAutostartRepair\(\{ ok: false/, "注入失败要记账，预算才不会永远花不完");
});

// ---------- 自愈 actor（ADR-0074 二次修订：`-restart` 与 daemon 启动共用同一判据+动作）----------
function fakeHealth(over = {}) {
  return {
    wanted: true, ok: false, reason: "未注册（任务计划与 HKCU Run 都没有）",
    paths: [], missing: [], supervised: false,
    status: { taskToRun: '"C:\\n\\node.exe" "D:\\gone\\bin\\mslxdff.js"' },
    repair: { fails: 0, at: 0, reason: "" }, budget: AUTOSTART_REPAIR_MAX_FAILS,
    ...over,
  };
}

test("repairAutostartOnce: 体检通过 ⇒ 一个进程都不派，但 restart 要看得见「查过了」", async () => {
  let spawns = 0; const lines = [];
  const r = await repairAutostartOnce({
    check: async () => fakeHealth({ ok: true, reason: "", paths: ["a", "b"] }),
    spawnHelper: () => { spawns++; return { pid: 1 }; },
    log: (m) => lines.push(m), platform: "win32", env: {}, reportOk: true,
  });
  assert.equal(r.action, "ok");
  assert.equal(spawns, 0, "健康时绝不能动注册");
  assert.match(lines.join("\n"), /体检通过/);
});

test("repairAutostartOnce: 失效 ⇒ 派 helper、立在途标记、留下旧注册值与事件", async () => {
  let spawns = 0, marks = 0; const lines = []; const events = [];
  const r = await repairAutostartOnce({
    check: async () => fakeHealth(),
    spawnHelper: () => { spawns++; return { pid: 4321 }; },
    mark: () => { marks++; },
    log: (m) => lines.push(m), onEvent: (e) => events.push(e), platform: "win32", env: {},
  });
  assert.equal(r.action, "spawned");
  assert.equal(spawns, 1);
  assert.equal(marks, 1, "派完必须立在途标记，否则 daemon 侧 2.5s 后的第二次体检会再派一个");
  assert.equal(r.helperPid, 4321);
  assert.match(lines.join("\n"), /旧注册值：/, "覆盖前把旧值打出来（用户裁决：坏注册直接覆盖，但要留得回来）");
  assert.equal(events[0].type, "autostart-takeover-spawned");
  assert.equal(events[0].prev.includes("gone"), true);
});

test("repairAutostartOnce: 三种「不该动」的情形一个进程都不派 —— 意愿关 / 预算耗尽 / 在途", async () => {
  const run = async (over, env = {}) => {
    let spawns = 0; const lines = [];
    const r = await repairAutostartOnce({
      check: async () => fakeHealth(over), spawnHelper: () => { spawns++; return { pid: 1 }; },
      mark: () => {}, log: (m) => lines.push(m), platform: "win32", env, now: () => 1000000,
    });
    return { r, spawns, out: lines.join("\n") };
  };
  const unwanted = await run({ wanted: false });
  assert.equal(unwanted.r.action, "unwanted");
  assert.equal(unwanted.spawns, 0, "用户 -disable-autostart 过 ⇒ 自愈不许跟他对着干");
  const broke = await run({ budget: 0, repair: { fails: 3, at: 0, reason: "拒绝访问" } });
  assert.equal(broke.r.action, "giveup");
  assert.equal(broke.spawns, 0);
  assert.match(broke.out, /停手，只告警/);
  const inflight = await run({ repair: { fails: 0, at: 995000, reason: "" } });
  assert.equal(inflight.r.action, "deferred");
  assert.equal(inflight.spawns, 0, "5s 前刚派过 helper ⇒ 本轮不重复派（restart 与 daemon 启动会各查一次）");
  assert.equal(inflight.r.sinceMs, 5000);
});

test("repairAutostartOnce: supervisor 在管就别抢（ADR-0064 的系统 unit 场景，CLI 进程看不见 underSystemd）", async () => {
  let spawns = 0;
  const r = await repairAutostartOnce({
    check: async () => fakeHealth({ supervised: true }),
    spawnHelper: () => { spawns++; return { pid: 1 }; }, mark: () => {}, platform: "linux", env: {},
  });
  assert.equal(r.action, "skip-supervised");
  assert.equal(spawns, 0, "抢系统 unit 的端口 = 0.1.209 无限重启原样复发");
});

test("repairAutostartOnce: 体检自己抛错只报 error，绝不冒泡打断 restart / daemon 启动", async () => {
  let spawns = 0;
  const r = await repairAutostartOnce({
    check: async () => { throw new Error("schtasks 挂了"); },
    spawnHelper: () => { spawns++; return { pid: 1 }; }, platform: "win32", env: {},
  });
  assert.equal(r.action, "error");
  assert.match(r.reason, /schtasks 挂了/);
  assert.equal(spawns, 0);
});

test("autostartRepairEnabled: win32/linux 都要，macOS 不要，两个 env 开关都认", () => {
  assert.equal(autostartRepairEnabled({}, "win32"), true);
  assert.equal(autostartRepairEnabled({}, "linux"), true);
  assert.equal(autostartRepairEnabled({}, "darwin"), false, "macOS 走 linuxEnable 必连败三次，不进自愈");
  assert.equal(autostartRepairEnabled({ MSLXDFF_NO_AUTOSTART: "1" }, "win32"), false);
  assert.equal(autostartRepairEnabled({ MSLXDFF_AUTOSTART_REPAIR: "0" }, "win32"), false);
  assert.equal(autostartRepairEnabled({ MSLXDFF_AUTOSTART_REPAIR: "OFF" }, "linux"), false);
  assert.equal(autostartRepairEnabled({ MSLXDFF_AUTOSTART_REPAIR: "1" }, "linux"), true);
});

test("markAutostartRepairAttempt: 只戳时间，不动失败计数也不抹原因", () => {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-test-autostart-"));
  const file = join(dir, "state.json");
  try {
    recordAutostartRepair({ ok: false, reason: "拒绝访问", file });
    const before = loadAutostartRepair({ file });
    const after = markAutostartRepairAttempt({ file });
    assert.equal(after.fails, before.fails, "在途标记不是失败记账");
    assert.equal(after.reason, "拒绝访问", "上一轮原因要留着");
    assert.ok(after.at >= before.at);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("源码级：-restart 本体确实调了自愈（用户点名，别再只埋在 daemon 启动路径里）", () => {
  const dj = readFileSync(new URL("../src/cli/commands/daemon.js", import.meta.url), "utf8");
  const at = dj.indexOf("export async function handleRestart");
  const body = dj.slice(at, dj.indexOf("export async function", at + 10));
  assert.ok(body.length > 200, "没定位到 handleRestart 函数体");
  assert.match(body, /repairAutostartOnce\(/, "-restart 必须真的调用自愈 actor");
  assert.match(body, /reportOk: true/, "-restart 的回执要连「体检通过」都打出来");
  assert.match(body, /action === "skip-env"/, "env 关着时要说明为什么没体检，别静默");
});
