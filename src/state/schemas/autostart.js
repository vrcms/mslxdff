import { readState, writeStateImmediate, defaultStateFile } from "../store.js";

/**
 * 开机自启的「意愿位」与「重注入台账」。
 *
 * 为什么要意愿位：开机自启是这台网关的命脉 —— Windows 没有 systemd `Restart=always` 兜底，
 * 注册一旦被安全/优化软件清掉（真机 2026-10-26：任务计划、HKCU Run、启动文件夹、WMI
 * StartupCommand 四处全空，`-autostart status` 只会老实显示「未启用」），就永久静默失效，
 * 没有任何自愈路径。于是 daemon 每次启动体检一次、缺了就补。
 *
 * 但「补」不能替别人决定开机自启，也不能和用户意愿打架：
 * - `autostart` 缺省（老 state 没这个键）= **要自启**；只有显式跑过 `-disable-autostart`
 *   写成 false，体检才闭嘴。
 * - `autostartRepair.fails` 连续失败计数由执行注入的那个进程写（CLI / helper），
 *   达 `AUTOSTART_REPAIR_MAX_FAILS` 后 daemon 只告警不再 fork —— 受限环境里
 *   `schtasks /create` 会被永久拒绝，不能每次重启都白派一个进程。
 */
export const AUTOSTART_REPAIR_MAX_FAILS = 3;

/** 用户是否要开机自启。缺省 = true（从未表态视为要）。env 不参与：这是本机意愿，不是运行参数。 */
export function loadAutostartWanted({ file } = {}) {
  try {
    const s = readState(file || defaultStateFile());
    return s?.autostart !== false;
  } catch {
    return true;
  }
}

export function saveAutostartWanted(on, { file } = {}) {
  const f = file || defaultStateFile();
  writeStateImmediate(f, { autostart: !!on });
  return !!on;
}

/** 重注入台账：`{ fails, at, reason }`，读不出来的脏值一律按「没失败过」处理。 */
export function loadAutostartRepair({ file } = {}) {
  try {
    const s = readState(file || defaultStateFile());
    const r = s?.autostartRepair;
    if (!r || typeof r !== "object") return { fails: 0, at: 0, reason: "" };
    return {
      fails: Number.isFinite(Number(r.fails)) && Number(r.fails) > 0 ? Number(r.fails) : 0,
      at: Number(r.at) || 0,
      reason: String(r.reason || ""),
    };
  } catch {
    return { fails: 0, at: 0, reason: "" };
  }
}

/** 记一次注入结果：成功清零，失败累加。返回写入后的台账，供调用方直接打印剩余预算。 */
export function recordAutostartRepair({ ok, reason = "", file } = {}) {
  const f = file || defaultStateFile();
  const cur = loadAutostartRepair({ file: f });
  const next = ok
    ? { fails: 0, at: Date.now(), reason: "" }
    : { fails: cur.fails + 1, at: Date.now(), reason: String(reason).slice(0, 300) };
  writeStateImmediate(f, { autostartRepair: next });
  return next;
}

/** 还剩几次重注入机会（0 = 已停手，只告警）。 */
export function autostartRepairBudget({ file } = {}) {
  return Math.max(0, AUTOSTART_REPAIR_MAX_FAILS - loadAutostartRepair({ file }).fails);
}

/**
 * 记一次「已派重注入」的时刻（**不动 fails 计数**）—— 供在途互斥（`REPAIR_INFLIGHT_MS`）判据使用。
 * 为什么不复用 recordAutostartRepair：那个函数只管成败、会把上一轮失败原因抹掉；这里只答
 * 「刚刚有没有人在补」，成败要等 helper 自己跑完 `-enable-autostart` 再记（ADR-0074 二次修订）。
 */
export function markAutostartRepairAttempt({ file } = {}) {
  const f = file || defaultStateFile();
  const cur = loadAutostartRepair({ file: f });
  const next = { fails: cur.fails, at: Date.now(), reason: cur.reason };
  writeStateImmediate(f, { autostartRepair: next });
  return next;
}
