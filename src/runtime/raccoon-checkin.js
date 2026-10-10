/**
 * raccoon 每日自动签到（daemon 内置），仿 src/runtime/qoder-checkin.js。
 * 开关：MSLXDFF_RACCOON_CHECKIN=0 关闭（默认开）；时间：MSLXDFF_RACCOON_CHECKIN_HOUR（默认 9 点本地时）。
 * 账号源 = auths/raccoon-<uid>.json；幂等由 credits.js 以账单为准判「今日已领」（不算失败）。
 * 积分制下签到是唯一日常回血途径（默认 3000 分/天），漏一天就少一天 —— 故内置到 daemon。
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

/** 账号文档 → credits.js 认的 credential 形状（与 CLI 的 firstCredential 同构）。 */
export function credentialFromAccountDoc(doc) {
  return {
    access_token: doc?.accessToken || "",
    refresh_token: doc?.refreshToken || "",
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
  const { claimRaccoonLoginReward } = await import("../providers/raccoon/credits.js");

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
        try {
          const r = await claimRaccoonLoginReward({
            credential: credentialFromAccountDoc(a),
            ...(fetchImpl ? { fetchImpl } : {}),
            env,
            ...(now === undefined ? {} : { now }),
          });
          results.push({ uid, ok: true, claimed: r.claimed, points: r.points });
        } catch (e) {
          results.push({ uid, ok: false, claimed: false, msg: String(e?.message || e).slice(0, 120) });
        }
      }
      const okCount = results.filter((r) => r.ok).length;
      const date = todayKey(now === undefined ? new Date() : new Date(now));
      try {
        stateMod.writeStateImmediate(stateMod.defaultStateFile(), {
          raccoonCheckin: { date, at: Date.now(), ok: okCount, total: results.length, accounts: results },
        });
      } catch {}
      for (const r of results) emit("raccoon-checkin-account", { ...r, reason });
      emit("raccoon-checkin-done", { date, ok: okCount, total: results.length, reason });
      return { ok: okCount > 0, okCount, total: results.length, results };
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
