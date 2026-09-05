import { compatFetch } from "../compat.js";
// daemon 内置 WorkBuddy 每日自动签到（A 方案）：多账号全签 + 启动补签 + 每日定时。
// 开关：MSLXDFF_WORKBUDDY_CHECKIN=0 关闭（默认开）；时间：MSLXDFF_WORKBUDDY_CHECKIN_HOUR（默认 9 点本地时）。
// 幂等：上游 code 10001（今天已签）视为成功；落盘 workbuddyCheckin {date} 防重复。

export function isCheckinEnabled(env = process.env) {
  const v = String(env.MSLXDFF_WORKBUDDY_CHECKIN ?? "1").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(v);
}

export function getCheckinHour(env = process.env) {
  const h = Number(env.MSLXDFF_WORKBUDDY_CHECKIN_HOUR);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 9;
}

export function todayKey(d = new Date()) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

// 到下一次计划点的毫秒数（今天未到点→今天，已过→明天同时）。
export function nextRunDelayMs(now = new Date(), hour = 9) {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

// 启动补签：已过今日计划点、且（从没签过 或 上次不是今天）。
export function shouldCatchUp({ lastDate, now = new Date(), hour = 9 } = {}) {
  const point = new Date(now);
  point.setHours(hour, 0, 0, 0);
  if (now.getTime() < point.getTime()) return false;
  return !lastDate || lastDate !== todayKey(now);
}

export async function setupWorkbuddyCheckin({ bus, logs } = {}) {
  function emit(type, data = {}) {
    const entry = { ts: Date.now(), type, ...data };
    try { bus?.emit(entry); } catch {}
    try { logs?.appendEvent?.(entry); } catch {}
    console.log(`[workbuddy-checkin] ${type} ${JSON.stringify(data)}`.slice(0, 500));
  }
  if (!isCheckinEnabled()) {
    console.log("[workbuddy-checkin] disabled (set MSLXDFF_WORKBUDDY_CHECKIN=1 to enable)");
    emit("workbuddy-checkin-disabled");
    return { enabled: false };
  }
  const hour = getCheckinHour();
  console.log(`[workbuddy-checkin] enabled: daily ${String(hour).padStart(2, "0")}:00 local, multi-account`);
  emit("workbuddy-checkin-enabled", { hour });

  const stateMod = await import("../state.js");
  const { checkinAll } = await import("../providers/workbuddy/checkin.js");
  const { createAuthService, decodeJwtExp } = await import("../providers/workbuddy/auth.js");

  let running = false;
  async function runOnce(reason) {
    if (running) return { skipped: "already-running" };
    running = true;
    try {
      const cfg = stateMod.loadProviderConfigs().workbuddy || {};
      const keys = [...(Array.isArray(cfg.keys) ? cfg.keys : [])];
      const authList = [...(Array.isArray(cfg.auths) ? cfg.auths : [])];
      if (!keys.length) {
        emit("workbuddy-checkin-no-accounts", { reason });
        return { ok: false, reason: "no-accounts" };
      }
      // 先给过期 token 续期（复用 chat 同款 refresh，落盘回 state）
      const authService = createAuthService({
        fetchImpl: compatFetch,
        store: { keys, authList },
      });
      await Promise.all(authList.map(async (auth, i) => {
        try {
          const exp = typeof decodeJwtExp === "function" ? decodeJwtExp(keys[i]) : null;
          if (exp && exp - Date.now() / 1000 < 3600) await authService.refreshTokenFor(keys[i], auth);
        } catch {}
      }));
      const accounts = authList.map((a, i) => ({ uid: a.uid, at: keys[i], domain: a.domain, enterpriseId: a.enterpriseId })).filter((a) => a.uid && a.at);
      const rows = await checkinAll({ accounts, concurrency: 3 });
      const okCount = rows.filter((r) => r.ok).length;
      const date = todayKey();
      try {
        stateMod.writeStateImmediate(stateMod.defaultStateFile(), {
          workbuddyCheckin: { date, at: Date.now(), ok: okCount, total: rows.length, accounts: rows.map((r) => ({ uid: r.uid, ok: r.ok, already: r.already })) },
        });
      } catch {}
      for (const r of rows) {
        emit("workbuddy-checkin-account", { uid: String(r.uid).slice(0, 8), ok: r.ok, already: !!r.already, msg: String(r.msg || "").slice(0, 120), reason });
      }
      emit("workbuddy-checkin-done", { date, ok: okCount, total: rows.length, reason });
      return { ok: okCount > 0, okCount, total: rows.length, rows };
    } catch (e) {
      emit("workbuddy-checkin-failed", { error: String(e?.message || e).slice(0, 200), reason });
      return { ok: false, error: String(e?.message || e).slice(0, 200) };
    } finally {
      running = false;
    }
  }

  // 启动补签：昨天没签且已过今天计划点，60s 后跑（等网络/上游就绪）
  try {
    const lastDate = stateMod.readState(stateMod.defaultStateFile())?.workbuddyCheckin?.date || "";
    if (shouldCatchUp({ lastDate, hour })) {
      setTimeout(() => { runOnce("catch-up").catch(() => {}); }, 60_000).unref?.();
      console.log(`[workbuddy-checkin] catch-up scheduled (last=${lastDate || "never"})`);
    }
  } catch {}
  // 每日定时：对齐到下一个计划点，跑完再约 24h 后
  function arm() {
    const delay = nextRunDelayMs(new Date(), hour);
    setTimeout(() => {
      runOnce("daily").catch(() => {}).finally(arm);
    }, delay).unref?.();
  }
  arm();
  return { enabled: true, hour, runOnce };
}
