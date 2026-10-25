// mslxdff -provider codearts checkin|quota —— 每日签到领积分（snap-access 的 `/v1/ops/*`）。
//
// 子命令：
//   checkin [--json] [--dry]        逐号补领今日积分（幂等：已到账零写操作；到账只认复查）
//   quota|credits|balance [--json]  只读查积分余额（`/snap-manager/v1/statistics/plugin`）
//
// ⚠ 与 `-provider codearts models` 那条「福利」**不是一回事**：福利走 opengw 的 benefit/claim（模型 Token 账），
//   积分走 snap-access 的 `/v1/ops/claim`（本文件）。两本账互不影响。
// ⚠ 判据口径：到账只认「领取后重读活动列表」的状态，不信 claim 回执
//   （raccoon 踩过「只信回执就谎报到账」，traework 同款纪律）。
import { normalizeProviderId } from "../../../providers/model-id.js";

const CHECKIN_SUBS = new Set(["checkin", "signin"]);
const QUOTA_SUBS = new Set(["quota", "credits", "balance"]);

function isCodearts(id) {
  return (normalizeProviderId(id) || String(id || "").toLowerCase()) === "codearts";
}
const uid8 = (account) => String(account?.userId || "(无 uid)").slice(0, 8);

/** 取号：deps.accounts 优先（测试注入，零网络）；否则 keys → provider 的 authPool（带刷新写回）。 */
async function loadAccounts(deps) {
  if (Array.isArray(deps.accounts)) return { accounts: deps.accounts, close: null };
  const { createCodeartsProvider } = await import("../../../providers/codearts/index.js");
  const provider = createCodeartsProvider({ fetchImpl: deps.fetchImpl });
  const pool = provider._pool;
  const accounts = [];
  for (const cand of pool.aliveAccounts()) {
    try { accounts.push(await pool.getCredential(cand.blob)); } catch { /* 死号跳过 */ }
  }
  return { accounts, close: () => { try { provider.close?.(); } catch { /* ignore */ } } };
}

/** 逐号补领今日积分。退出码：一个都没成 → 1（旧写法恒 0 会让人以为签好了）。 */
export async function handleCodeartsCheckin(id, sub, rest = [], deps = {}) {
  if (!isCodearts(id) || !CHECKIN_SUBS.has(String(sub || "").toLowerCase())) return false;
  const log = deps.log || ((m) => console.log(m));
  const exit = deps.exit || ((code) => process.exit(code));
  const wantsJson = rest.includes("--json") || rest.includes("-json");
  const dry = rest.includes("--dry") || rest.includes("--probe");

  const { accounts, close } = await loadAccounts(deps);
  try {
    if (!accounts.length) {
      if (wantsJson) log(JSON.stringify({ provider: "codearts", error: "no_accounts", hint: "mslxdff -provider codearts login" }));
      else log("没有 codearts 账号，请先 mslxdff -provider codearts login");
      exit(1);
      return true;
    }
    const { runCheckin } = deps.checkinModule || (await import("../../../providers/codearts/checkin.js"));
    const rows = [];
    for (const account of accounts) {
      let r;
      try {
        r = await runCheckin({ account, fetchImpl: deps.fetchImpl, dry });
      } catch (e) {
        r = { ok: false, status: "error", claimed: 0, credits: 0, message: String(e?.message || e).slice(0, 140) };
      }
      const row = { uid: uid8(account), ok: r.ok, status: r.status, claimed: r.claimed, credits: r.credits, msg: String(r.message || "").slice(0, 140) };
      rows.push(row);
      if (!wantsJson) {
        const mark = r.ok ? (r.status === "already" ? "✓ 今日已领取" : r.status === "nothing" ? "－ 无可用签到活动" : `✓ ${r.message}`) : `✗ ${r.message}`;
        log(`  [${row.uid}] ${mark}`);
      }
    }
    const okCount = rows.filter((r) => r.ok).length;
    const credits = rows.reduce((s, r) => s + (r.credits || 0), 0);
    if (wantsJson) {
      log(JSON.stringify({ provider: "codearts", dry: Boolean(dry), ok: okCount, total: rows.length, credits, accounts: rows }));
    } else {
      log("");
      log(`codearts 签到：${okCount}/${rows.length} 号完成，本次到账 ${credits} 积分`);
      if (dry) log("  （--dry 干跑：未发任何写请求）");
    }
    exit(okCount > 0 ? 0 : 1);
    return true;
  } finally {
    try { close?.(); } catch { /* ignore */ }
  }
}

/** 只读：逐号查积分余额（`usageTotalPackageCredit` 口径，分类明细单列不累加）。 */
export async function handleCodeartsQuota(id, sub, rest = [], deps = {}) {
  if (!isCodearts(id) || !QUOTA_SUBS.has(String(sub || "").toLowerCase())) return false;
  const log = deps.log || ((m) => console.log(m));
  const exit = deps.exit || ((code) => process.exit(code));
  const wantsJson = rest.includes("--json") || rest.includes("-json");

  const { accounts, close } = await loadAccounts(deps);
  try {
    if (!accounts.length) {
      if (wantsJson) log(JSON.stringify({ provider: "codearts", error: "no_accounts", hint: "mslxdff -provider codearts login" }));
      else log("没有 codearts 账号，请先 mslxdff -provider codearts login");
      exit(1);
      return true;
    }
    const { fetchCreditBalance } = deps.checkinModule || (await import("../../../providers/codearts/checkin.js"));
    const rows = [];
    for (const account of accounts) {
      let r;
      try { r = await fetchCreditBalance({ account, fetchImpl: deps.fetchImpl }); } catch (e) { r = { ok: false, error: String(e?.message || e).slice(0, 140) }; }
      rows.push({ uid: uid8(account), ok: r.ok, total: r.total, used: r.used, remain: r.remain, tokenUsage: r.tokenUsage, error: r.ok ? "" : String(r.error || `HTTP ${r.status || "-"}`).slice(0, 140) });
    }
    const failed = rows.filter((r) => !r.ok).length;
    const allBad = rows.length > 0 && failed === rows.length;
    if (wantsJson) {
      log(JSON.stringify({ provider: "codearts", ok: rows.length - failed, total: rows.length, note: "remain=余额；total 是总额非上限", accounts: rows }));
      exit(allBad ? 1 : 0);
      return true;
    }
    log(`codearts 积分 · 共 ${rows.length} 个号`);
    for (const r of rows) {
      if (!r.ok) { log(`  [${r.uid}] ❌ ${r.error}`); continue; }
      log(`  [${r.uid}] 剩余 ${r.remain} / 共 ${r.total}（已用 ${r.used}）· token 用量 ${r.tokenUsage}`);
    }
    log("");
    log("  每日签到: mslxdff -provider codearts checkin");
    exit(allBad ? 1 : 0);
    return true;
  } finally {
    try { close?.(); } catch { /* ignore */ }
  }
}