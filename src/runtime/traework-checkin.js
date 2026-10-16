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

export async function setupTraeworkCheckin({ bus, logs, deps = {} } = {}) {
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
  const fetchImpl = deps.fetchImpl || compatFetch; // 注入缝：无此参数则测试只能打真上游（会真领积分），故必开

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
      const { checkinStatus, checkinClaimVerified } = await import("../providers/traework/checkin.js");
      const results = await Promise.all(authList.map(async (auth, i) => {
        const at = keys[i];
        const uid = auth?.uid;
        if (!uid || !at) return { uid, ok: false, msg: "missing key/uid" };
        // keys 槽位不像凭据（被 CLI 误写过）时别去打上游，直接给人话
        if (at.trim().length < 20 || [...at].some((c) => c.trim() === "")) {
          return { uid, ok: false, msg: `keys[${i}] 不像 accessToken（${at.length} 字符），重跑 -provider traework login 回填` };
        }
        try {
          const cred = { accessToken: at, deviceId: auth?.deviceId || "", uid };
          const st = await checkinStatus({ cred, fetchImpl });
          // 判据一律走复核：旧写法 claim 一跑完就 return ok:true，实测上游 checked_in 仍 false 而 state 记 ok:1
          const r = await checkinClaimVerified({ cred, fetchImpl, before: st });
          return { uid, ok: r.claimed || r.already, already: r.already, phantom: r.phantom, credits: r.credits, msg: r.msg };
        } catch (e) {
          return { uid, ok: false, msg: String(e?.message || e).slice(0, 120) };
        }
      }));
      const okCount = results.filter((r) => r.ok).length;
      const phantomCount = results.filter((r) => r.phantom).length;
      // 只在真有人到账时才把 date 盖成今天：shouldCatchUp 的判据是 lastDate !== 今天，
      // 谎报时盖 date 会把当日补签一并掐掉（本次那 100 分就是这么丢的）。
      const prevState = stateMod.readState(stateMod.defaultStateFile()) || {};
      const date = okCount > 0 ? todayKey() : String(prevState.traeworkCheckin?.date || "");
      try {
        stateMod.writeStateImmediate(stateMod.defaultStateFile(), {
          traeworkCheckin: {
            date,
            at: Date.now(),
            ok: okCount,
            total: results.length,
            phantom: phantomCount,
            lastAttempt: todayKey(),
            accounts: results.map((r) => ({ uid: String(r.uid || "").slice(0, 8), ok: r.ok, already: !!r.already, phantom: !!r.phantom, credits: Number(r.credits) || 0, msg: String(r.msg || "").slice(0, 120) })),
          },
        });
      } catch {}
      for (const r of results) {
        emit("traework-checkin-account", { uid: String(r.uid || "").slice(0, 8), ok: r.ok, already: !!r.already, phantom: !!r.phantom, credits: Number(r.credits) || 0, msg: String(r.msg || "").slice(0, 120), reason });
      }
      if (phantomCount) emit("traework-checkin-phantom", { phantom: phantomCount, total: results.length, reason, hint: "上游回执未报错但复查 checked_in=false → 判未到账，不记为已签，下次启动仍补签" });
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