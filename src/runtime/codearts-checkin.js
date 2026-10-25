/**
 * codearts 每日签到领积分（daemon 内置），仿 src/runtime/qoder-checkin.js。
 * 开关：MSLXDFF_CODEARTS_CHECKIN=0 关闭（默认开）；时间：MSLXDFF_CODEARTS_CHECKIN_HOUR（默认 9 点）。
 * 账号源：providerConfigs.codearts.keys 的凭据 blob —— 复用 createCodeartsProvider 的 authPool，
 * 刷新轮转换号**原位写回**（自己写 saveFn 会与 chat 路径的写回逻辑分叉）。
 * 该上游对并发极敏感 → 逐号**串行**；ops 是独立端点，不占 chat 的并发闸（3 会话上限不受影响）。
 * 记账：state.codeartsCheckin {date, at, ok, total, credits, accounts:[…]}（qoder/workbuddy 同款）。
 */
import { todayKey, nextRunDelayMs, shouldCatchUp } from "./workbuddy-checkin.js";

export function isCheckinEnabled(env = process.env) {
  const v = String(env.MSLXDFF_CODEARTS_CHECKIN ?? "1").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(v);
}

export function getCheckinHour(env = process.env) {
  const h = Number(env.MSLXDFF_CODEARTS_CHECKIN_HOUR);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 9;
}

export async function setupCodeartsCheckin({ bus, logs, deps = {} } = {}) {
  const env = deps.env || process.env;
  function emit(type, data = {}) {
    const entry = { ts: Date.now(), type, ...data };
    try { bus?.emit(entry); } catch { /* 事件不阻断签到 */ }
    try { logs?.appendEvent?.(entry); } catch { /* 同上 */ }
    try { console.log(`[codearts-checkin] ${type} ${JSON.stringify(data)}`.slice(0, 500)); } catch { /* 同上 */ }
  }
  if (!isCheckinEnabled(env)) {
    console.log("[codearts-checkin] disabled (set MSLXDFF_CODEARTS_CHECKIN=1 to enable)");
    emit("codearts-checkin-disabled");
    return { enabled: false };
  }
  const hour = getCheckinHour(env);
  console.log(`[codearts-checkin] enabled: daily ${String(hour).padStart(2, "0")}:00 local, multi-account serial`);
  emit("codearts-checkin-enabled", { hour });

  const stateMod = await import("../state.js");

  /** 取号：deps.accounts 优先（测试注入，零网络）；否则走 provider 的 authPool（缺省带写回）。 */
  async function loadAccounts() {
    if (Array.isArray(deps.accounts)) return { accounts: deps.accounts, close: null };
    const { createCodeartsProvider } = await import("../providers/codearts/index.js");
    const provider = deps.provider || createCodeartsProvider({ fetchImpl: deps.fetchImpl });
    const pool = provider._pool;
    const accounts = [];
    let candidates = [];
    try { candidates = pool.aliveAccounts() || []; } catch { candidates = []; }
    for (const cand of candidates) {
      try { accounts.push(await pool.getCredential(cand.blob)); } catch { /* 死号跳过，别拖垮整轮 */ }
    }
    return { accounts, close: () => { try { provider.close?.(); } catch { /* ignore */ } } };
  }

  let running = false;
  async function runOnce(reason) {
    if (running) return { skipped: "already-running" };
    running = true;
    let cleanup = null;
    try {
      const loaded = await loadAccounts();
      cleanup = loaded.close;
      const accounts = loaded.accounts;
      if (!accounts.length) {
        emit("codearts-checkin-no-accounts", { reason });
        return { ok: false, reason: "no-accounts" };
      }
      const { runCheckin } = await import("../providers/codearts/checkin.js");
      const rows = [];
      for (const account of accounts) { // 逐号串行：该上游对并发极敏感
        const uid = String(account?.userId || "").slice(0, 8);
        try {
          const r = await runCheckin({ account, fetchImpl: deps.fetchImpl });
          rows.push({ uid, ok: r.ok, status: r.status, claimed: r.claimed, credits: r.credits, msg: String(r.message || "").slice(0, 140) });
        } catch (e) {
          rows.push({ uid, ok: false, status: "error", claimed: 0, credits: 0, msg: String(e?.message || e).slice(0, 140) });
        }
      }
      const okCount = rows.filter((r) => r.ok).length;
      const credits = rows.reduce((s, r) => s + (r.credits || 0), 0);
      const date = todayKey();
      try {
        stateMod.writeStateImmediate(stateMod.defaultStateFile(), {
          codeartsCheckin: { date, at: Date.now(), ok: okCount, total: rows.length, credits, accounts: rows },
        });
      } catch { /* 落盘失败不影响本次结果 */ }
      for (const r of rows) emit("codearts-checkin-account", { ...r, reason });
      emit("codearts-checkin-done", { date, ok: okCount, total: rows.length, credits, reason });
      return { ok: okCount > 0, okCount, total: rows.length, rows };
    } catch (e) {
      emit("codearts-checkin-failed", { error: String(e?.message || e).slice(0, 200), reason });
      return { ok: false, error: String(e?.message || e).slice(0, 200) };
    } finally {
      try { cleanup?.(); } catch { /* ignore */ }
      running = false;
    }
  }

  // 启动补跑：已过今日计划点、且（从没签过 或 上次不是今天）
  try {
    const lastDate = stateMod.readState(stateMod.defaultStateFile())?.codeartsCheckin?.date || "";
    if (shouldCatchUp({ lastDate, hour })) {
      setTimeout(() => { runOnce("catch-up").catch(() => {}); }, 90_000).unref?.();
      console.log(`[codearts-checkin] catch-up scheduled (last=${lastDate || "never"})`);
    }
  } catch { /* 读 state 失败就不补跑，等定时 */ }
  function arm() {
    const delay = nextRunDelayMs(new Date(), hour);
    setTimeout(() => {
      runOnce("daily").catch(() => {}).finally(arm);
    }, delay).unref?.();
  }
  arm();
  return { enabled: true, hour, runOnce };
}