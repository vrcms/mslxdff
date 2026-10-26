import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { underSystemd } from "./proc-info.js";

/**
 * 开机自启「重注入」的唯一执行者 —— daemon 启动自愈与 CLI `-restart` 共用这一份。
 *
 * 为什么要抽出来（2026-10-26，ADR-0074 二次修订）：用户点名「`-restart` 里没查吗？」——
 * 第一版把体检只埋在 daemon 启动路径（`server-lifecycle.js`），于是 `-restart` 的输出一行
 * 相关回执都没有，也说不清「查过没查过」。判据与动作散在调用方 = 迟早长第二套真相。
 *
 * 三条不变量（改动时一条都不能破）：
 * 1. **绝不在本进程里调 `enableAutostart()`**：它在 Linux 的语义是「停掉裸 daemon、把端口
 *    让给 systemd」，由裸 daemon 自己调用 = 举手自杀（0.1.236 真机，ADR-0069）。CLI 侧同样
 *    危险：`-restart` 刚把新 daemon 起来，inline 一句 `enableAutostart()` 就会把它当裸 daemon 停掉。
 *    ⇒ 动作一律交给 detached helper 子进程。
 * 2. **在途互斥**：CLI 刚派完 helper，2.5s 后 daemon 启动自愈会**再看一次**（那时注册往往还没
 *    写完）⇒ 不去重就会连派两个进程抢着 `schtasks /create /f`。判据 = 台账 `autostartRepair.at`
 *    距今 < `REPAIR_INFLIGHT_MS` 就认「已经有人在补了」，本轮只报 deferred。
 * 3. **systemd 托管下整块跳过**：supervisor 已保证单实例+自启；且本块查的是 **user** unit，
 *    被**系统** unit 托管时必得 enabled=false ⇒ 误判成「没注册」而反复接管（2026-10-19 无限重启）。
 */
export const REPAIR_INFLIGHT_MS = 60_000;

/** helper 走的是正经 CLI 入口 `-enable-autostart`；带 NO_AUTOSTART 防它自己再触发一次自愈。 */
export function spawnAutostartHelper() {
  const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "mslxdff.js");
  const child = spawn(process.execPath, [entry, "-enable-autostart"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, MSLXDFF_DAEMON: "", MSLXDFF_NO_AUTOSTART: "1" },
  });
  child.unref();
  return child;
}

/** 平台与 env 开关：macOS 排除（没有 systemd，走 linuxEnable 必连败三次）。 */
export function autostartRepairEnabled(env = process.env, platform = process.platform) {
  if (platform !== "win32" && platform !== "linux") return false;
  if (env.MSLXDFF_NO_AUTOSTART) return false;
  const off = String(env.MSLXDFF_AUTOSTART_REPAIR ?? "").trim().toLowerCase();
  return off !== "0" && off !== "off" && off !== "false";
}

/**
 * 体检一次，必要时派 helper 重注入。返回结构化判决（`action`），并把人话回执交给 `log`。
 * `reportOk=true`（CLI 用）时连「体检通过」也打一行 —— restart 要看得见自己查过了。
 */
export async function repairAutostartOnce({
  log = () => {},
  onEvent = () => {},
  reportOk = false,
  check = null,
  env = process.env,
  platform = process.platform,
  inflightMs = REPAIR_INFLIGHT_MS,
  now = () => Date.now(),
  spawnHelper = null,
  mark = null,
} = {}) {
  if (!autostartRepairEnabled(env, platform)) return { action: "skip-env" };
  if (platform === "linux" && underSystemd()) return { action: "skip-systemd" };
  const doSpawn = spawnHelper || spawnAutostartHelper;
  const { checkAutostartHealth } = check ? { checkAutostartHealth: check } : await import("../autostart.js");
  const doMark = mark || (await import("../state.js")).markAutostartRepairAttempt;
  let h;
  try {
    h = check ? await check() : await checkAutostartHealth();
  } catch (e) {
    return { action: "error", reason: String(e?.message || e) };
  }
  if (h.supervised) {
    // 有 supervisor 在管就别抢：systemd 已保证单实例+自启，重复注入只会与它互踢（ADR-0064/0069）
    if (reportOk) log("autostart: 由 supervisor 托管中（systemd），体检不接管、不重注入");
    return { action: "skip-supervised" };
  }
  if (!h.wanted) {
    if (reportOk) log("autostart: 按意愿关闭（-disable-autostart 过），本次不补注册");
    return { action: "unwanted" };
  }
  if (h.ok) {
    if (reportOk) log(`autostart: 体检通过 — 注册在，且里面的路径都还在${h.paths.length ? `（${h.paths.length} 条）` : ""}`);
    return { action: "ok" };
  }
  const prev = String(h.status?.taskToRun || h.status?.execStart || "").trim();
  const since = now() - (h.repair?.at || 0);
  if (h.repair?.at && since < inflightMs) {
    log(`autostart 失效（${h.reason}）→ 已有重注入在途（${Math.round(since / 1000)}s 前派的），本轮不重复派`);
    return { action: "deferred", reason: h.reason, sinceMs: since };
  }
  if (h.budget <= 0) {
    log(`autostart 已失效（${h.reason}），但连续重注入已失败 ${h.repair?.fails ?? "?"} 次 —— 停手，只告警：查权限或手动 mslxdff -enable-autostart（整块开关 MSLXDFF_AUTOSTART_REPAIR=0）`);
    onEvent({ ts: now(), type: "autostart-repair-giveup", reason: h.reason, fails: h.repair?.fails ?? null });
    return { action: "giveup", reason: h.reason };
  }
  const helper = doSpawn();
  if (!helper?.pid) {
    log("autostart 已失效且接管进程未启动：请手动运行 mslxdff -enable-autostart");
    return { action: "spawn-failed", reason: h.reason };
  }
  // 先立在途标记再返回：否则 daemon 侧 2.5s 后的第二次体检看不到「刚有人派过」
  try { doMark(); } catch {}
  log(`autostart 失效（${h.reason}）→ 已派接管进程 (pid ${helper.pid}) 重注入，剩余预算 ${h.budget - 1} 次${prev ? `；旧注册值：${prev}` : ""}`);
  onEvent({ ts: now(), type: "autostart-takeover-spawned", pid: helper.pid, reason: h.reason, prev, platform });
  return { action: "spawned", reason: h.reason, helperPid: helper.pid, prev };
}
