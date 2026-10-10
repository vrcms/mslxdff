/**
 * raccoon 登录奖励的 daemon 兜底扫描（仿 src/runtime/qoder-checkin.js 的排程形态）。
 * 开关：MSLXDFF_RACCOON_CHECKIN=0 关闭（默认开）；时间：MSLXDFF_RACCOON_CHECKIN_HOUR（默认 9 点本地时）。
 * ⚠ 性质纠偏（2026-10-10 账单实测）：**这家没有"每日签到"可领** ——
 *   每日 300 由服务端自动发放且当天 23:59:59 清零（无端点）；唯一要领的是「桌面端登录奖励 3000」，**每号一次性**。
 *   正常路径是 `raccoon login` 成功后立刻领掉（那时 token 最新鲜）；本任务只是兜底：
 *   扫出"历史上没领过"的号补领一次，领过的号每天只花一次账单查询即判"已领"，不再打写端点。
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
  const { claimRaccoonLoginReward, raccoonClaimStatus } = await import("../providers/raccoon/credits.js");
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
        // access_token 只有约 3 小时寿命。过期的号一律跳过，**绝不去碰 refresh**：网关请求可能正在同一时刻
        // 续同一个号，而 refresh_token 是一次性轮换的，两边抢同一条 token 等于亲手把号烧掉。
        if (isRaccoonExpired(credential)) {
          results.push({ uid, ok: false, claimed: false, status: "auth_stale", msg: "登录态已过期，需重新扫码：mslxdff -provider raccoon login" });
          continue;
        }
        try {
          const r = await claimRaccoonLoginReward({
            credential,
            ...(fetchImpl ? { fetchImpl } : {}),
            env,
          });
          // 四种答复必须分开显示：只有 claimed 是真到账；already 是一次性礼包领过了（正常态）；
          // phantom = 上游回 code:0 但账单没这笔（实测行为）；unverified = 账单查不动，不下结论。
          const status = raccoonClaimStatus(r);
          results.push({ uid, ok: status === "claimed" || status === "already", claimed: r.claimed, status, points: r.points });
        } catch (e) {
          results.push({ uid, ok: false, claimed: false, status: "error", msg: String(e?.message || e).slice(0, 120) });
        }
      }
      const got = results.filter((r) => r.status === "claimed").length;
      const already = results.filter((r) => r.status === "already").length;
      const date = todayKey(now === undefined ? new Date() : new Date(now));
      try {
        stateMod.writeStateImmediate(stateMod.defaultStateFile(), {
          raccoonCheckin: { date, at: Date.now(), ok: got + already, claimed: got, already, total: results.length, accounts: results },
        });
      } catch {}
      for (const r of results) emit("raccoon-checkin-account", { ...r, reason });
      emit("raccoon-checkin-done", { date, ok: got + already, claimed: got, already, total: results.length, reason });
      return { ok: got + already > 0, claimed: got, already, total: results.length, results };
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
