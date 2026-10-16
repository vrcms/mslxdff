// mslxdff -provider traework checkin|quota —— 签到与积分（仿 qoder 的 login/checkin 分文件范式）。
//
// 子命令：
//   checkin            逐号补领今日积分（到账与否**只认领取后复查**，见 providers/traework/checkin.js 头注）
//   quota|credits|balance [--json]  只读查签到状态与积分额度：走 api.trae.cn 状态接口，**不发模型请求、不烧配额**
//
// ⚠ 两个读数口径（2026-10-15 实测，别再当余额看）：
//   1. 「额度上限」= 各 entitlement pack 的 credits_limit 求和，是**上限**不是剩余；上游没有已用/剩余字段，
//      所以模型报 4008（requests exceeded the quota）时这个数照样非零。
//   2. 今日是否真签到只认 checkinStatus().checked_in，不认 claim 回执 —— raccoon 踩过同一坑
//      （见 raccoon-quota.js:3-5「判据一律走账单，只信回执就会谎报到账」）。
import { normalizeProviderId } from "../../../providers/model-id.js";
import { compatFetch } from "../../../compat.js";

const CHECKIN_SUBS = new Set(["checkin", "signin"]);
const QUOTA_SUBS = new Set(["quota", "credits", "balance"]);
// keys 与 auths 是平行数组（account-store 按位序成对）。不像凭据的槽位 = 多半被 CLI 误写过。
const looksLikeCredential = (k) => typeof k === "string" && k.trim().length >= 20 && ![...k].some((c) => c.trim() === "");
const badKeyHint = (i, len) => `keys[${i}] 不像 accessToken（${len} 字符），疑被误写 → mslxdff -provider traework login 重登回填（或查 auths/trae-<uid>.json）`;

function isTraework(id) {
  return (normalizeProviderId(id) || String(id || "").toLowerCase()) === "traework";
}

// 按位序配号：keys[i] ↔ auths[i]，只回 uid 与 token，绝不外打完整 token（凭据纪律）。
function accounts(keys, authList) {
  const out = [];
  for (let i = 0; i < Math.max(keys.length, authList.length); i++) {
    const auth = authList[i] || {};
    const at = keys[i] || "";
    if (!auth?.uid && !at) continue;
    out.push({ uid: String(auth.uid || "(无 uid)"), accessToken: at, deviceId: auth.deviceId || "" });
  }
  return out;
}

async function loadCreds(deps) {
  const { loadProviderConfig, loadProviderKeys } = await import("../../../state.js");
  const cfg = deps.config ?? loadProviderConfig("traework") ?? {};
  return {
    keys: deps.keys || loadProviderKeys("traework") || [],
    authList: deps.auths || cfg.auths || [],
  };
}

/** 手动补领今日积分。退出码：一个都没到账 → 1（旧写法恒 0，配合谎报的 ok:true 会让人以为签好了）。 */
export async function handleTraeworkCheckin(id, sub, rest = [], deps = {}) {
  if (!isTraework(id) || !CHECKIN_SUBS.has(String(sub || "").toLowerCase())) return false;
  const fetchImpl = deps.fetchImpl || compatFetch;
  const log = deps.log || ((m) => console.log(m));
  const exit = deps.exit || ((code) => process.exit(code));
  const { keys, authList } = await loadCreds(deps);
  if (!keys.length || !authList.length) {
    console.error("没有 traework 账号，请先 mslxdff -provider traework login");
    exit(1);
    return true;
  }
  const { checkinStatus, checkinClaimVerified, entUsage } = deps.checkinModule || (await import("../../../providers/traework/checkin.js"));
  let landed = 0, tried = 0;
  for (const a of accounts(keys, authList)) {
    tried++;
    log(`账号 ${a.uid.slice(0, 8)}...`);
    if (!looksLikeCredential(a.accessToken)) { log(`  ✗ ${badKeyHint(tried - 1, a.accessToken.length)}`); continue; }
    const cred = { accessToken: a.accessToken, deviceId: a.deviceId, uid: a.uid };
    try {
      const st = await checkinStatus({ cred, fetchImpl });
      log(`  签到状态: checked_in=${st.checkedIn} credits=${st.credits} enable=${st.enable}`);
      const r = await checkinClaimVerified({ cred, fetchImpl, before: st });
      if (r.claimed) { landed++; log("  签到: ✓ 已到账（复查 checked_in=true）"); }
      else if (r.already) { landed++; log("  签到: 今日已签过，跳过领取"); }
      else if (r.phantom) log("  签到: ✗ 未到账 —— 上游回执没报错但复查 checked_in 仍 false，**别当今天签过了**，稍后重试");
      else log(`  签到: ✗ ${r.msg || "未到账"}`);
      const ent = await entUsage({ cred, fetchImpl });
      log(`  积分额度上限: ${ent.totalCredits}（${ent.packCount} 个权益包 · 非剩余可用）`);
    } catch (e) {
      log(`  失败: ${String(e?.message || e).slice(0, 120)}`);
    }
  }
  if (!deps.noExit) exit(landed === 0 && tried > 0 ? 1 : 0);
  return true;
}

/** 只读视图：逐号打印签到状态 + 积分额度上限。 */
export async function handleTraeworkQuota(id, sub, rest = [], deps = {}) {
  if (!isTraework(id) || !QUOTA_SUBS.has(String(sub || "").toLowerCase())) return false;
  const log = deps.log || ((m) => console.log(m));
  const exit = deps.exit || ((code) => process.exit(code));
  const wantsJson = rest.includes("--json") || rest.includes("-json");
  const { keys, authList } = await loadCreds(deps);

  if (!keys.length && !authList.length) {
    if (wantsJson) log(JSON.stringify({ error: "not_logged_in", hint: "mslxdff -provider traework login" }));
    else {
      log("未登录：还没有 traework 账号");
      log("  先运行: mslxdff -provider traework login（登录后自动回填 keys/auths 并签到）");
    }
    exit(1);
    return true;
  }

  const { checkinStatus, entUsage } = deps.checkinModule || (await import("../../../providers/traework/checkin.js"));
  const fetchImpl = deps.fetchImpl || compatFetch;
  const list = [];
  for (const [i, a] of accounts(keys, authList).entries()) {
    const base = { uid: a.uid, tokenLen: a.accessToken.length };
    if (!looksLikeCredential(a.accessToken)) {
      list.push({ ...base, ok: false, msg: `keys 槽位不像凭据（${a.accessToken.length} 字符），疑被误写`, fix: badKeyHint(i, a.accessToken.length) });
      continue;
    }
    const cred = { accessToken: a.accessToken, deviceId: a.deviceId, uid: a.uid };
    try {
      const st = await checkinStatus({ cred, fetchImpl });
      const ent = await entUsage({ cred, fetchImpl });
      list.push({ ...base, ok: true, checkedIn: st.checkedIn, enable: st.enable, dailyCredits: st.credits, totalCredits: ent.totalCredits, packCount: ent.packCount, isCreditsBilling: ent.isCreditsBilling });
    } catch (e) {
      list.push({ ...base, ok: false, msg: String(e?.message || e).slice(0, 140), fix: "登录态可能已失效：mslxdff -provider traework login" });
    }
  }
  const failed = list.filter((r) => !r.ok).length;
  const allBad = failed === list.length && list.length > 0;

  if (wantsJson) {
    log(JSON.stringify({ provider: "traework", accounts: list, ok: list.length - failed, total: list.length, note: "totalCredits 是额度上限非剩余" }));
    exit(allBad ? 1 : 0);
    return true;
  }

  log(`traework 签到与积分 · 共 ${list.length} 个号`);
  for (const r of list) {
    if (!r.ok) {
      log(`  [${r.uid}] ❌ ${r.msg}`);
      if (r.fix) log(`      → ${r.fix}`);
      continue;
    }
    const sign = r.checkedIn ? "✓ 今日已签到" : r.enable ? "○ 今日未签到" : "－ 上游未开放签到";
    log(`  [${r.uid}] ${sign} · 每日可领 ${r.dailyCredits} · 额度上限 ${r.totalCredits}（${r.packCount} 个权益包）`);
  }
  log("");
  log("  ⚠ 「额度上限」= 各权益包 credits_limit 之和，**不是剩余可用**；上游无已用/剩余字段。");
  log("  ⚠ 判还能不能用只认模型报错本身：4008 exceeded = 该池已触顶，与上面的总数无关。");
  log("  补领今日积分: mslxdff -provider traework checkin");
  exit(allBad ? 1 : 0);
  return true;
}
