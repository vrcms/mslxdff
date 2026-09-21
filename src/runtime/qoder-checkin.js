/**
 * qoder 每日自动签到（daemon 内置），仿 src/runtime/traework-checkin.js。
 * 开关：MSLXDFF_QODER_CHECKIN=0 关闭（默认开）；时间：MSLXDFF_QODER_CHECKIN_HOUR（默认 9 点）。
 * 账号源 = auths/qoder-<uid>.json（每号自带 region，cn 走 daily-check-in，global 走 campaigns）。
 * 只领真积分（CLAIM_BENEFIT / daily-check-in）；VIEW_DETAILS 等促销条目需手动 --any 才碰。
 */
import { todayKey, nextRunDelayMs, shouldCatchUp } from "./workbuddy-checkin.js";

export function isCheckinEnabled(env = process.env) {
  const v = String(env.MSLXDFF_QODER_CHECKIN ?? "1").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(v);
}

export function getCheckinHour(env = process.env) {
  const h = Number(env.MSLXDFF_QODER_CHECKIN_HOUR);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 9;
}

export async function setupQoderCheckin({ bus, logs } = {}) {
  function emit(type, data = {}) {
    const entry = { ts: Date.now(), type, ...data };
    try { bus?.emit(entry); } catch {}
    try { logs?.appendEvent?.(entry); } catch {}
    try { console.log(`[qoder-checkin] ${type} ${JSON.stringify(data)}`.slice(0, 500)); } catch {}
  }
  if (!isCheckinEnabled()) {
    console.log("[qoder-checkin] disabled (set MSLXDFF_QODER_CHECKIN=1 to enable)");
    emit("qoder-checkin-disabled");
    return { enabled: false };
  }
  const hour = getCheckinHour();
  console.log(`[qoder-checkin] enabled: daily ${String(hour).padStart(2, "0")}:00 local`);
  emit("qoder-checkin-enabled", { hour });

  const stateMod = await import("../state.js");
  const { listAccountDocs } = await import("../providers/qoder/account-store.js");

  let running = false;
  async function runOnce(reason) {
    if (running) return { skipped: "already-running" };
    running = true;
    try {
      const accounts = listAccountDocs()
        .map((d) => ({ uid: d.uid, deviceToken: d.doc?.auth?.deviceToken || "", region: d.doc?.auth?.region || "global" }))
        .filter((a) => a.deviceToken);
      if (!accounts.length) {
        emit("qoder-checkin-no-accounts", { reason });
        return { ok: false, reason: "no-accounts" };
      }
      const { runCheckin } = await import("../providers/qoder/checkin.js");
      const results = [];
      for (const a of accounts) {
        try {
          const r = await runCheckin({ deviceToken: a.deviceToken, region: a.region });
          results.push({ uid: String(a.uid).slice(0, 8), region: r.region, ok: r.ok, status: r.status, amount: r.amount, msg: r.message });
        } catch (e) {
          results.push({ uid: String(a.uid).slice(0, 8), region: a.region, ok: false, status: "error", msg: String(e?.message || e).slice(0, 120) });
        }
      }
      const okCount = results.filter((r) => r.ok).length;
      const date = todayKey();
      try {
        stateMod.writeStateImmediate(stateMod.defaultStateFile(), {
          qoderCheckin: { date, at: Date.now(), ok: okCount, total: results.length, accounts: results },
        });
      } catch {}
      for (const r of results) emit("qoder-checkin-account", { ...r, reason });
      emit("qoder-checkin-done", { date, ok: okCount, total: results.length, reason });
      return { ok: okCount > 0, okCount, total: results.length };
    } catch (e) {
      emit("qoder-checkin-failed", { error: String(e?.message || e).slice(0, 200), reason });
      return { ok: false, error: String(e?.message || e).slice(0, 200) };
    } finally {
      running = false;
    }
  }

  try {
    const lastDate = stateMod.readState(stateMod.defaultStateFile())?.qoderCheckin?.date || "";
    if (shouldCatchUp({ lastDate, hour })) {
      setTimeout(() => { runOnce("catch-up").catch(() => {}); }, 90_000).unref?.();
      console.log(`[qoder-checkin] catch-up scheduled (last=${lastDate || "never"})`);
    }
  } catch {}
  function arm() {
    const delay = nextRunDelayMs(new Date(), hour);
    setTimeout(() => {
      runOnce("daily").catch(() => {}).finally(arm);
    }, delay).unref?.();
  }
  arm();
  return { enabled: true, hour, runOnce };
}
