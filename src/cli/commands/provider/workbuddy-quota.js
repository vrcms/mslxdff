// mslxdff -provider workbuddy quota|checkin —— 查还漏领多少积分 / 手动补领
//
// 子命令：
//   quota|credits|balance [--json]  只读：逐号列出未领任务、连登天数、可兑换档位、抽奖次数
//   checkin|claim                   补领：连登兑换 + 抽奖 + 成长任务闭环（含桌面/专家类）
//
// ⚠ 只读口径（2026-10-20 实测）：
//   - 签到每天成功（code 0）**不等于**连登点亮；连登只认 /v2/report 的
//     chat_request_send 事件，所以「签到 OK + 连登 0 天」是常态，不是异常。
//   - 任务列表与领奖只在 www.workbuddy.cn 命中（web 成长中心口径）。
import { normalizeProviderId } from "../../../providers/model-id.js";
import { compatFetch } from "../../../compat.js";

const QUOTA_SUBS = new Set(["quota", "credits", "balance"]);
const CLAIM_SUBS = new Set(["checkin", "claim", "signin"]);

async function loadCreds() {
  const { loadProviderConfig, loadProviderKeys } = await import("../../../state.js");
  const cfg = loadProviderConfig("workbuddy") || {};
  const keys = loadProviderKeys("workbuddy") || [];
  const authList = Array.isArray(cfg.auths) ? cfg.auths : [];
  const out = [];
  for (let i = 0; i < Math.max(keys.length, authList.length); i++) {
    const a = authList[i] || {};
    const at = keys[i] || "";
    if (!a.uid || !at) continue;
    out.push({ uid: a.uid, at, domain: a.domain, enterpriseId: a.enterpriseId || "" });
  }
  return out;
}

const short = (uid) => String(uid).slice(0, 8);

export async function handleWorkbuddyQuota(id, sub, rest = [], deps = {}) {
  const pid = normalizeProviderId(id) || String(id || "").toLowerCase();
  if (pid !== "workbuddy") return false;
  const s = String(sub || "").toLowerCase();
  const isClaim = CLAIM_SUBS.has(s);
  if (!isClaim && !QUOTA_SUBS.has(s)) return false;

  const log = deps.log || ((m) => console.log(m));
  const exit = deps.exit || ((code) => process.exit(code));
  const json = rest.includes("--json") || rest.includes("-json");
  const fetchImpl = deps.fetchImpl || compatFetch;
  const accounts = await loadCreds();
  if (!accounts.length) {
    if (json) log(JSON.stringify({ error: "not_logged_in", hint: "mslxdff -provider workbuddy login" }));
    else {
      log("未登录：还没有 workbuddy 账号");
      log("  先运行: mslxdff -provider workbuddy login");
    }
    exit(1);
    return true;
  }

  const { growthTasks, runGrowthAccount } = await import("../../../providers/workbuddy/growth.js");
  const { growthStreak, lotteryChances, reportChatActivity, runStreakBonus } = await import("../../../providers/workbuddy/activity.js");

  const rows = [];
  for (const a of accounts) {
    const row = { uid: a.uid, ok: true };
    try {
      if (isClaim) {
        const rep = await reportChatActivity({ ...a, fetchImpl });
        const sb = await runStreakBonus({ ...a, fetchImpl });
        const g = await runGrowthAccount({ ...a, fetchImpl });
        row.activity = rep.ok;
        row.streak = { days: sb.days, redeemed: sb.redeemed, drawn: sb.drawn, credit: sb.credit, errors: sb.errors };
        const claimed = g.tasks.filter((t) => t.status === "claimed");
        row.growth = {
          credit: g.credit, energy: g.energy,
          claimed: claimed.map((t) => t.task_code),
          ignored: g.tasks.filter((t) => t.fired > 0 && !["claimed", "completed"].includes(String(t.status || ""))).map((t) => t.task_code),
          skipped: g.tasks.filter((t) => t.skipped).length,
          error: g.error,
        };
        row.ok = rep.ok || g.ok;
      } else {
        const listed = await growthTasks({ ...a, fetchImpl });
        const tasks = listed.tasks || [];
        const pending = tasks.filter((t) => t.accept_status !== "claimed");
        row.tasksError = listed.ok ? null : listed.msg || "拉取失败";
        row.pending = pending.map((t) => ({
          code: t.task_code,
          credit: Number(t.reward_credit || 0),
          energy: Number(t.reward_energy || 0),
          status: t.accept_status,
          progress: `${t.progress?.current ?? t.current ?? 0}/${t.progress?.target ?? t.target ?? 0}`,
        }));
        row.pendingCredit = row.pending.reduce((n, t) => n + t.credit, 0);
        row.claimed = tasks.filter((t) => t.accept_status === "claimed").length;
        const st = await growthStreak({ ...a, fetchImpl });
        row.streak = { days: st.days, tiers: st.tiers, cards: st.cards, error: st.ok ? undefined : st.msg };
        const lot = await lotteryChances({ ...a, fetchImpl });
        row.chances = lot.chances;
        row.ok = !!listed.ok;
      }
    } catch (e) {
      row.ok = false;
      row.error = String(e?.message || e).slice(0, 160);
    }
    rows.push(row);
  }

  const failed = rows.filter((r) => !r.ok).length;

  if (json) {
    log(JSON.stringify({ provider: "workbuddy", mode: isClaim ? "claim" : "quota", accounts: rows, ok: rows.length - failed, total: rows.length }));
    exit(failed === rows.length ? 1 : 0);
    return true;
  }

  if (isClaim) {
    log(`workbuddy 补领 · 共 ${rows.length} 个号`);
    for (const r of rows) {
      log(`  [${short(r.uid)}]`);
      if (r.error) { log(`    ❌ ${r.error}`); continue; }
      log(`    活跃上报: ${r.activity ? "✓ 已点亮连登" : "✗ 失败"}`);
      const s = r.streak || {};
      const tiers = (s.redeemed || []).map((x) => `${x.tier}(+${x.credit}c)`).join(" ") || "-";
      log(`    连登: ${s.days ?? "?"} 天 · 兑换 ${tiers} · 抽奖 ${s.drawn ?? 0} 次 · +${s.credit ?? 0} 分`);
      if (s.errors?.length) log(`    ⚠ ${s.errors.join("；")}`);
      const g = r.growth || {};
      log(`    成长任务: 到账 ${g.claimed?.length ?? 0} 项 · +${g.credit ?? 0} 分 · 跳过 ${g.skipped ?? 0} 项`);
      if (g.claimed?.length) log(`      已领: ${g.claimed.join(", ")}`);
      if (g.ignored?.length) log(`      ⚠ 上报未计分（该任务只认客户端真实行为）: ${g.ignored.join(", ")}`);
      if (g.error) log(`    ⚠ ${g.error}`);
    }
    log("");
    log("  复核: mslxdff -provider workbuddy quota");
    exit(failed === rows.length ? 1 : 0);
    return true;
  }

  log(`workbuddy 已领 / 未领 · 共 ${rows.length} 个号`);
  let totalPending = 0;
  for (const r of rows) {
    if (r.error) { log(`  [${short(r.uid)}] ❌ ${r.error}`); continue; }
    totalPending += r.pendingCredit || 0;
    const st = r.streak || {};
    const unlocked = (st.tiers || []).filter((t) => !["locked", "claimed"].includes(t.status));
    log(`  [${short(r.uid)}] 已领 ${r.claimed} 项 · 未领 ${r.pending.length} 项 合计 ${r.pendingCredit} 分`);
    log(`      连登 ${st.days} 天${st.cards ? ` · 补签卡 ${st.cards}` : ""} · 可兑档位 ${unlocked.map((t) => t.tier).join(",") || "无"} · 抽奖次数 ${r.chances}`);
    for (const t of r.pending) {
      log(`      · ${t.code.padEnd(28)} +${String(t.credit).padEnd(4)} c  ${t.status} ${t.progress}`);
    }
    if (r.tasksError) log(`      ⚠ 任务列表拉取失败：${r.tasksError}`);
  }
  log("");
  log(`  未领合计 ${totalPending} 分（不含连登档位与抽奖）`);
  log("  补领: mslxdff -provider workbuddy checkin");
  exit(failed === rows.length ? 1 : 0);
  return true;
}
