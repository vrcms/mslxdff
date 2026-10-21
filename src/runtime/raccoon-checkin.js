/**
 * raccoon 每日任务：**每日积分结算**（每天必做）+ 登录奖励补领（每号一次性）。
 * 开关：MSLXDFF_RACCOON_CHECKIN=0 关闭（默认开）；时间：MSLXDFF_RACCOON_CHECKIN_HOUR（默认 9 点本地时）。
 *
 * ⚠ 性质纠偏（2026-10-21 账单实测，推翻 2026-10-10 的旧结论）：
 *   这家的每日积分是**惰性结算**——服务端按天挂账，当天第一次访问 `/api/web/office/v3/setting_info`
 *   才真正入账（入账即有效期到 T+6 的 23:59:59，即官方文案「当天登录后延长至 7 天」）。
 *   不访问该端点，当天 `daily_points` 恒 0、账单里连 `daily_grant` 都没有。
 *   所以本任务每天必做的第一件事就是打这个端点（幂等，连打多次只入账一次）。
 *   第二件事才是「桌面端登录奖励 3000」的补领：**每号一次性**，正常路径是 `raccoon login` 时领掉，
 *   本任务只是兜底：扫出"历史上没领过"的号补领一次，领过的号每天只花一次账单查询即判"已领"。
 */
import { todayKey, nextRunDelayMs, shouldCatchUp } from "./workbuddy-checkin.js";

export function isCheckinEnabled(env = process.env) {
  const v = String(env.MSLXDFF_RACCOON_CHECKIN ?? "1").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(v);
}

export function getCheckinHour(env = process.env) {
  const h = Number(env.MSLXDFF_RACCOON_CHECKIN_HOUR);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 9;
}

/** 账号文档 → credits.js 认的 credential 形状（与 provider 内 credentialFor 同构）。 */
export function credentialFromAccountDoc(doc) {
  return {
    access_token: doc?.accessToken || "",
    refresh_token: doc?.refreshToken || "",
    // ⚠ expires_at 必须带上：少了它，isRaccoonExpired / isRaccoonExpiringSoon 一律判不出来（只能回落去解 JWT，
    // 而假 token 解不出 → undefined → 保守判「未过期」），结果就是过期号照发请求去撞 401、临期号该续不续。
    expires_at: doc?.expiresAt || "",
    office_identity: doc?.officeIdentity || "",
    device_id: doc?.deviceId || "",
    uid: doc?.uid || "",
  };
}

export async function setupRaccoonCheckin({ bus, logs, fetchImpl, dirs, env = process.env, now } = {}) {
  function emit(type, data = {}) {
    const entry = { ts: Date.now(), type, ...data };
    try { bus?.emit(entry); } catch {}
    try { logs?.appendEvent?.(entry); } catch {}
    try { console.log(`[raccoon-checkin] ${type} ${JSON.stringify(data)}`.slice(0, 500)); } catch {}
  }
  if (!isCheckinEnabled(env)) {
    console.log("[raccoon-checkin] disabled (set MSLXDFF_RACCOON_CHECKIN=1 to enable)");
    emit("raccoon-checkin-disabled");
    return { enabled: false };
  }
  const hour = getCheckinHour(env);
  console.log(`[raccoon-checkin] enabled: daily ${String(hour).padStart(2, "0")}:00 local`);
  emit("raccoon-checkin-enabled", { hour });

  const stateMod = await import("../state.js");
  const { listRaccoonAccountDocs } = await import("../providers/raccoon/account-store.js");
  const { claimRaccoonDailyPoints, claimRaccoonLoginReward, raccoonClaimStatus, raccoonDailyStatus } = await import("../providers/raccoon/credits.js");
  const { isRaccoonExpired } = await import("../providers/raccoon/auth.js");

  let running = false;
  async function runOnce(reason) {
    if (running) return { skipped: "already-running" };
    running = true;
    try {
      const accounts = listRaccoonAccountDocs(dirs ? { dirs } : {}).filter((d) => d.accessToken);
      if (!accounts.length) {
        emit("raccoon-checkin-no-accounts", { reason });
        return { ok: false, reason: "no-accounts" };
      }
      const results = [];
      for (const a of accounts) {
        const uid = String(a.uid).slice(0, 8);
        const credential = credentialFromAccountDoc(a);
        // 登录态过期的号一律跳过，**绝不去碰 refresh**：网关请求可能正在同一时刻
        // 续同一个号，而 refresh_token 是一次性轮换的，两边抢同一条 token 等于亲手把号烧掉。
        // （实测 access_token 寿命是 30 天而非注释里旧写的 3 小时，所以正常情况下每日任务不会撞上这条）
        if (isRaccoonExpired(credential)) {
          results.push({ uid, ok: false, claimed: false, daily: "auth_stale", status: "auth_stale", msg: "登录态已过期，需重新扫码：mslxdff -provider raccoon login" });
          continue;
        }

        // 第一件：每日积分结算（惰性钩子，幂等）。失败不拖累下面的补领 —— 两件事互不依赖。
        let daily = "error";
        let dailyPoints = 0;
        try {
          const d = await claimRaccoonDailyPoints({ credential, ...(fetchImpl ? { fetchImpl } : {}), env, ...(now === undefined ? {} : { now }) });
          daily = raccoonDailyStatus(d);
          dailyPoints = d.points || 0;
        } catch {
          daily = "error";
        }

        // 第二件：一次性登录奖励补领。四种答复必须分开显示：只有 claimed 是真到账；
        // already 是一次性礼包领过了（正常态）；phantom = 上游回 code:0 但账单没这笔（实测行为）；
        // unverified = 账单查不动，不下结论。
        let reward = "error";
        let rewardPoints = 0;
        let msg;
        try {
          const r = await claimRaccoonLoginReward({ credential, ...(fetchImpl ? { fetchImpl } : {}), env });
          reward = raccoonClaimStatus(r);
          rewardPoints = r.points || 0;
        } catch (e) {
          msg = String(e?.message || e).slice(0, 120);
        }

        results.push({
          uid,
          ok: daily === "claimed" || daily === "already",
          daily,
          dailyPoints,
          reward,
          rewardPoints,
          status: daily === "auth_stale" ? "auth_stale" : daily,
          ...(msg === undefined ? {} : { msg }),
        });
      }
      const dailyGot = results.filter((r) => r.daily === "claimed").length;
      const dailyDone = results.filter((r) => r.daily === "claimed" || r.daily === "already").length;
      const rewardGot = results.filter((r) => r.reward === "claimed").length;
      const already = results.filter((r) => r.reward === "already").length;
      const date = todayKey(now === undefined ? new Date() : new Date(now));
      try {
        stateMod.writeStateImmediate(stateMod.defaultStateFile(), {
          raccoonCheckin: {
            date,
            at: Date.now(),
            ok: dailyDone,
            dailyClaimed: dailyGot,
            dailyDone,
            claimed: rewardGot,
            already,
            total: results.length,
            accounts: results,
          },
        });
      } catch {}
      for (const r of results) emit("raccoon-checkin-account", { ...r, reason });
      emit("raccoon-checkin-done", {
        date,
        ok: dailyDone,
        dailyClaimed: dailyGot,
        dailyDone,
        claimed: rewardGot,
        already,
        total: results.length,
        reason,
      });
      return { ok: dailyDone > 0, dailyClaimed: dailyGot, dailyDone, claimed: rewardGot, already, total: results.length, results };
    } catch (e) {
      emit("raccoon-checkin-failed", { error: String(e?.message || e).slice(0, 200), reason });
      return { ok: false, error: String(e?.message || e).slice(0, 200) };
    } finally {
      running = false;
    }
  }

  // 启动补签：今天已过计划点、且（从没签过 或 上次不是今天）→ 90s 后跑（等网络/上游就绪）
  try {
    const lastDate = stateMod.readState(stateMod.defaultStateFile())?.raccoonCheckin?.date || "";
    if (shouldCatchUp({ lastDate, hour })) {
      setTimeout(() => { runOnce("catch-up").catch(() => {}); }, 90_000).unref?.();
      console.log(`[raccoon-checkin] catch-up scheduled (last=${lastDate || "never"})`);
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
