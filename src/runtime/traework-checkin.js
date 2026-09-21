/**
 * traework 每日自动签到（daemon 内置），仿 src/runtime/workbuddy-checkin.js。
 * 开关：MSLXDFF_TRAEWORK_CHECKIN=0 关闭（默认开）；时间：MSLXDFF_TRAEWORK_CHECKIN_HOUR（默认 9 点）。
 * 多账号全签 + 启动补签 + 每日定时。
 */
import { compatFetch } from "../compat.js";
import { todayKey, nextRunDelayMs, shouldCatchUp } from "./workbuddy-checkin.js";

export function isCheckinEnabled(env = process.env) {
  const v = String(env.MSLXDFF_TRAEWORK_CHECKIN ?? "1").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(v);
}

export function getCheckinHour(env = process.env) {
  const h = Number(env.MSLXDFF_TRAEWORK_CHECKIN_HOUR);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 9;
}

export async function setupTraeworkCheckin({ bus, logs } = {}) {
  function emit(type, data = {}) {
    const entry = { ts: Date.now(), type, ...data };
    try { bus?.emit(entry); } catch {}
    try { logs?.appendEvent?.(entry); } catch {}
    try { console.log(`[traework-checkin] ${type} ${JSON.stringify(data)}`.slice(0, 500)); } catch {}
  }
  if (!isCheckinEnabled()) {
    console.log("[traework-checkin] disabled (set MSLXDFF_TRAEWORK_CHECKIN=1 to enable)");
    emit("traework-checkin-disabled");
    return { enabled: false };
  }
  const hour = getCheckinHour();
  console.log(`[traework-checkin] enabled: daily ${String(hour).padStart(2, "0")}:00 local`);
  emit("traework-checkin-enabled", { hour });

  const stateMod = await import("../state.js");
  const fetchImpl = compatFetch;

  let running = false;
  async function runOnce(reason) {
    if (running) return { skipped: "already-running" };
    running = true;
    try {
      const cfg = stateMod.loadProviderConfigs().traework || {};
      const keys = [...(Array.isArray(cfg.keys) ? cfg.keys : [])];
      const authList = [...(Array.isArray(cfg.auths) ? cfg.auths : [])];
      if (!keys.length || !authList.length) {
        emit("traework-checkin-no-accounts", { reason });
        return { ok: false, reason: "no-accounts" };
      }
      const { checkinStatus, checkinClaim } = await import("../providers/traework/checkin.js");
      const results = await Promise.all(authList.map(async (auth, i) => {
        const at = keys[i];
        const uid = auth?.uid;
        if (!uid || !at) return { uid, ok: false, msg: "missing key/uid" };
        try {
          const cred = { accessToken: at, deviceId: auth?.deviceId || "", uid };
          const st = await checkinStatus({ cred, fetchImpl });
          if (st.checkedIn) return { uid, ok: true, already: true, credits: st.credits };
          if (!st.enable) return { uid, ok: false, msg: "checkin not enabled" };
          await checkinClaim({ cred, fetchImpl });
          const st2 = await checkinStatus({ cred, fetchImpl });
          return { uid, ok: true, already: false, credits: st2.credits };
        } catch (e) {
          return { uid, ok: false, msg: String(e?.message || e).slice(0, 120) };
        }
      }));
      const okCount = results.filter((r) => r.ok).length;
      const date = todayKey();
      try {
        stateMod.writeStateImmediate(stateMod.defaultStateFile(), {
          traeworkCheckin: { date, at: Date.now(), ok: okCount, total: results.length, accounts: results.map((r) => ({ uid: String(r.uid || "").slice(0, 8), ok: r.ok, already: !!r.already })) },
        });
      } catch {}
      for (const r of results) {
        emit("traework-checkin-account", { uid: String(r.uid || "").slice(0, 8), ok: r.ok, already: !!r.already, msg: String(r.msg || "").slice(0, 120), reason });
      }
      emit("traework-checkin-done", { date, ok: okCount, total: results.length, reason });
      return { ok: okCount > 0, okCount, total: results.length };
    } catch (e) {
      emit("traework-checkin-failed", { error: String(e?.message || e).slice(0, 200), reason });
      return { ok: false, error: String(e?.message || e).slice(0, 200) };
    } finally {
      running = false;
    }
  }

  // 启动补签
  try {
    const lastDate = stateMod.readState(stateMod.defaultStateFile())?.traeworkCheckin?.date || "";
    if (shouldCatchUp({ lastDate, hour })) {
      setTimeout(() => { runOnce("catch-up").catch(() => {}); }, 60_000).unref?.();
      console.log(`[traework-checkin] catch-up scheduled (last=${lastDate || "never"})`);
    }
  } catch {}
  // 每日定时
  function arm() {
    const delay = nextRunDelayMs(new Date(), hour);
    setTimeout(() => {
      runOnce("daily").catch(() => {}).finally(arm);
    }, delay).unref?.();
  }
  arm();
  return { enabled: true, hour, runOnce };
}