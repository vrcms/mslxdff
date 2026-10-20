import { compatFetch } from "../compat.js";
import { todayKey, nextRunDelayMs, shouldCatchUp } from "./workbuddy-checkin.js";
// daemon 内置 WorkBuddy 成长任务 + 猫猫旅行每日自动（A 方案）：
// 多账号串行（任务间 1.2s、账号间 1s 节流）+ 启动补跑 + 每日定时（默认 09:30，与 09:00 签到错峰）。
// 开关：MSLXDFF_WORKBUDDY_GROWTH=0 关闭（默认开）；时间：MSLXDFF_WORKBUDDY_GROWTH_HOUR（默认 9）。
// 幂等：已 claimed 的任务跳过；结果落 state.workbuddyGrowth 防重复补跑。

export const GROWTH_MINUTE = 30;

export function isGrowthEnabled(env = process.env) {
  const v = String(env.MSLXDFF_WORKBUDDY_GROWTH ?? "1").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(v);
}

export function getGrowthHour(env = process.env) {
  const h = Number(env.MSLXDFF_WORKBUDDY_GROWTH_HOUR);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 9;
}

export function nextGrowthDelayMs(now = new Date(), hour = 9, minute = GROWTH_MINUTE) {
  return nextRunDelayMs(now, hour, minute);
}

export function shouldGrowthCatchUp({ lastDate, now = new Date(), hour = 9, minute = GROWTH_MINUTE } = {}) {
  return shouldCatchUp({ lastDate, now, hour, minute });
}

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (typeof t.unref === "function") t.unref(); });

export async function setupWorkbuddyGrowth({ bus, logs } = {}) {
  function emit(type, data = {}) {
    const entry = { ts: Date.now(), type, ...data };
    try { bus?.emit(entry); } catch {}
    try { logs?.appendEvent?.(entry); } catch {}
    console.log(`[workbuddy-growth] ${type} ${JSON.stringify(data)}`.slice(0, 500));
  }
  if (!isGrowthEnabled()) {
    console.log("[workbuddy-growth] disabled (set MSLXDFF_WORKBUDDY_GROWTH=1 to enable)");
    emit("workbuddy-growth-disabled");
    return { enabled: false };
  }
  const hour = getGrowthHour();
  console.log(`[workbuddy-growth] enabled: daily ${String(hour).padStart(2, "0")}:${GROWTH_MINUTE} local, multi-account serial`);
  emit("workbuddy-growth-enabled", { hour, minute: GROWTH_MINUTE });

  const stateMod = await import("../state.js");
  const { runGrowthAll } = await import("../providers/workbuddy/growth.js");
  const { runCatTravel } = await import("../providers/workbuddy/cat-travel.js");
  const { reportChatActivity, runStreakBonus } = await import("../providers/workbuddy/activity.js");
  const { createAuthService, decodeJwtExp } = await import("../providers/workbuddy/auth.js");

  let running = false;
  async function loadAccounts() {
    const cfg = stateMod.loadProviderConfigs().workbuddy || {};
    const keys = [...(Array.isArray(cfg.keys) ? cfg.keys : [])];
    const authList = [...(Array.isArray(cfg.auths) ? cfg.auths : [])];
    if (!keys.length) return null;
    // 先给临期 token 续期（与签到调度同款：refresh 结果经 store 回写 state 与 auths 文件）
    const authService = createAuthService({ fetchImpl: compatFetch, store: { keys, authList } });
    await Promise.all(authList.map(async (auth, i) => {
      try {
        const exp = decodeJwtExp(keys[i]);
        if (exp && exp - Date.now() / 1000 < 3600) await authService.refreshTokenFor(keys[i], auth);
      } catch {}
    }));
    return authList
      .map((a, i) => ({ uid: a.uid, at: keys[i], domain: a.domain, enterpriseId: a.enterpriseId }))
      .filter((a) => a.uid && a.at);
  }

  async function runOnce(reason) {
    if (running) return { skipped: "already-running" };
    running = true;
    try {
      const accounts = await loadAccounts();
      if (!accounts?.length) {
        emit("workbuddy-growth-no-accounts", { reason });
        return { ok: false, reason: "no-accounts" };
      }
      const growthRes = await runGrowthAll({
        accounts,
        onAccount: (row) => emit("workbuddy-growth-account", {
          uid: String(row.uid).slice(0, 8), ok: row.ok, credit: row.credit,
          tasks: row.tasks.filter((t) => t.ok && !t.skipped).length, reason,
        }),
      });
      // 活跃上报必须单独发：签到不点亮连登（2026-10-20 实测 days 恒 0），
      // 不报就连登档位 7/14/28 天的积分与抽奖次数永远拿不到。
      const activity = [];
      const streak = [];
      for (const a of accounts) {
        const r = await reportChatActivity(a);
        activity.push({ uid: a.uid, ok: r.ok, msg: r.msg });
        emit("workbuddy-activity", { uid: String(a.uid).slice(0, 8), ok: r.ok, msg: r.msg, reason });
        const s = await runStreakBonus({ ...a, onStep: (e) => emit("workbuddy-streak", { uid: String(a.uid).slice(0, 8), ...e }) });
        streak.push({ uid: a.uid, days: s.days, redeemed: s.redeemed, drawn: s.drawn, credit: s.credit, errors: s.errors });
        emit("workbuddy-streak-done", {
          uid: String(a.uid).slice(0, 8), days: s.days,
          redeemed: s.redeemed.map((x) => x.tier).join(",") || "-", drawn: s.drawn, credit: s.credit,
          errors: s.errors.length ? s.errors : undefined, reason,
        });
        await sleep(1000);
      }
      const travel = [];
      for (const a of accounts) {
        try {
          const r = await runCatTravel({ uid: a.uid, at: a.at, domain: a.domain, enterpriseId: a.enterpriseId });
          travel.push({ uid: a.uid, outcome: r.outcome, credits: r.credits, summary: r.summary });
          emit("workbuddy-growth-travel", { uid: String(a.uid).slice(0, 8), outcome: r.outcome, credits: r.credits, reason });
        } catch (e) {
          travel.push({ uid: a.uid, outcome: "error", credits: 0, summary: String(e?.message || e).slice(0, 120) });
        }
        await sleep(1000);
      }
      const date = todayKey();
      const streakCredit = streak.reduce((s, r) => s + (r.credit || 0), 0);
      const creditTotal = growthRes.creditTotal + travel.reduce((s, r) => s + (r.credits || 0), 0) + streakCredit;
      try {
        stateMod.writeStateImmediate(stateMod.defaultStateFile(), {
          workbuddyGrowth: {
            date, at: Date.now(), ok: growthRes.ok, credit: creditTotal, accounts: accounts.length,
            streakCredit,
            activity: activity.map((a) => ({ uid: a.uid, ok: a.ok })),
            streak: streak.map((s) => ({ uid: s.uid, days: s.days, drawn: s.drawn, credit: s.credit })),
            travel: travel.map((t) => ({ uid: t.uid, outcome: t.outcome, credits: t.credits })),
          },
        });
      } catch {}
      emit("workbuddy-growth-done", { date, accounts: accounts.length, credit: creditTotal, streakCredit, ok: growthRes.ok, reason });
      return { ok: true, creditTotal, streakCredit, growthRes, travel, streak };
    } catch (e) {
      emit("workbuddy-growth-failed", { error: String(e?.message || e).slice(0, 200), reason });
      return { ok: false, error: String(e?.message || e).slice(0, 200) };
    } finally {
      running = false;
    }
  }

  // 启动补跑：昨天没跑且已过今天计划点，60s 后跑（等网络/上游就绪）
  try {
    const lastDate = stateMod.readState(stateMod.defaultStateFile())?.workbuddyGrowth?.date || "";
    if (shouldGrowthCatchUp({ lastDate, hour })) {
      setTimeout(() => { runOnce("catch-up").catch(() => {}); }, 60_000).unref?.();
      console.log(`[workbuddy-growth] catch-up scheduled (last=${lastDate || "never"})`);
    }
  } catch {}
  function arm() {
    const delay = nextGrowthDelayMs(new Date(), hour);
    setTimeout(() => {
      runOnce("daily").catch(() => {}).finally(arm);
    }, delay).unref?.();
  }
  arm();
  return { enabled: true, hour, minute: GROWTH_MINUTE, runOnce };
}
