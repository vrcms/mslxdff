// traework 签到/积分（照抄 traework2api internal/upstream/client.go Checkin* + UserEntUsage）。
import { UG_HOST, EP_CHECKIN_STATUS, EP_CHECKIN_CLAIM, EP_ENT_USAGE } from "./constants.js";
import { ugHeaders } from "./headers.js";
import { compatFetch, timeoutSignal } from "../../compat.js";
import { ensureMarketIdentity } from "./account-store.js";

// 三个 UG 接口共用这一发：市场身份在此统一挂载，调用点就不必各自记得带
// （少带一件 x-device-id，claim 即回 9004；见 headers.js 的 ugHeaders 注释）。
function withUgIdentity(cred = {}) {
  if (cred.market) return cred; // 调用方已备好自己的身份（含测试注入）→ 尊重它，不越权读盘
  const uid = String(cred.uid || "").trim();
  return { ...cred, market: ensureMarketIdentity(uid) };
}

async function postJson(fetchImpl, url, cred, timeoutMs = 15000) {
  const res = await fetchImpl(url, { method: "POST", headers: ugHeaders(withUgIdentity(cred)), body: "{}", signal: timeoutSignal(timeoutMs) });
  const txt = await res.text().catch(() => "");
  let j = null;
  try { j = JSON.parse(txt); } catch { j = { _raw: txt.slice(0, 200) }; }
  return { res, json: j };
}

export async function checkinStatus({ cred, baseUrl = UG_HOST, fetchImpl = compatFetch, timeoutMs = 15000 } = {}) {
  const { res, json } = await postJson(fetchImpl, `${String(baseUrl).replace(/\/+$/, "")}${EP_CHECKIN_STATUS}`, cred, timeoutMs);
  if (res.status >= 400) throw Object.assign(new Error(`checkin status http ${res.status}`), { status: res.status });
  return { checkedIn: Boolean(json?.checked_in), credits: Number(json?.credits) || 0, enable: Boolean(json?.enable) };
}

// 领取每日签到积分。⚠ 别单用本函数判成败：上游对重复领取照样回 HTTP 200（raccoon 踩过同一坑，
//   判据口径见 src/cli/commands/provider/raccoon-quota.js:3-5「只信回执就会谎报到账」）。
//   本函数只做「HTTP 通了 + 回执 code 非明确失败」；到账与否请用下面 checkinClaimVerified。
//   `code` 字段缺失时不判失败——claim 的响应体没实测过，不臆造上游契约。
export async function checkinClaim({ cred, baseUrl = UG_HOST, fetchImpl = compatFetch, timeoutMs = 15000 } = {}) {
  const { res, json } = await postJson(fetchImpl, `${String(baseUrl).replace(/\/+$/, "")}${EP_CHECKIN_CLAIM}`, cred, timeoutMs);
  if (res.status >= 400) throw Object.assign(new Error(`checkin claim http ${res.status}`), { status: res.status });
  const code = json && typeof json === "object" && json.code !== undefined ? Number(json.code) : undefined;
  return {
    ok: code === undefined || code === 0,
    code,
    message: String(json?.message || json?.msg || "").slice(0, 120),
    raw: json,
  };
}

/**
 * 领取并**复核到账** —— 签到唯一该用的入口。
 * `claimed` 只在「领取后复查 checkinStatus().checkedIn === true」时为真；
 * 回执没报错但复查仍 false → `phantom: true`，调用方必须按**未签到**处理（绝不写进 state 当今天签过了）。
 * opts.before：调用方已查过状态时传进来，省一次往返。
 */
export async function checkinClaimVerified(opts = {}) {
  const before = opts.before || (await checkinStatus(opts));
  if (before.checkedIn) return { claimed: false, already: true, phantom: false, checkedIn: true, credits: before.credits, msg: "" };
  if (!before.enable) return { claimed: false, already: false, phantom: false, checkedIn: false, credits: before.credits, msg: "checkin not enabled" };
  let claim = { ok: false, code: undefined, message: "" };
  try {
    claim = await checkinClaim(opts);
  } catch (e) {
    return { claimed: false, already: false, phantom: false, checkedIn: false, credits: before.credits, msg: `claim http: ${String(e?.message || e).slice(0, 80)}` };
  }
  const after = await checkinStatus(opts);
  if (after.checkedIn) return { claimed: true, already: false, phantom: false, checkedIn: true, credits: after.credits, msg: "" };
  const why = claim.ok ? "上游回执未报错、但复查 checked_in 仍为 false（判未到账）" : `上游回执 code=${claim.code}${claim.message ? ` ${claim.message}` : ""}`;
  return { claimed: false, already: false, phantom: claim.ok, checkedIn: false, credits: after.credits, msg: why.slice(0, 120) };
}

// 积分额度：把 ide_user_ent_usage 各 pack 的 credits_limit 求和。
// ⚠ 这是**额度上限**、不是剩余可用：实测该接口只回 credits_limit 与 enable_solo_* 开关，
//   没有任何已用/剩余字段。故模型报 4008（requests exceeded the quota）时本数照样非零 —— 别拿它当余额判生死。
export async function entUsage({ cred, baseUrl = UG_HOST, fetchImpl = compatFetch, timeoutMs = 15000 } = {}) {
  const { res, json } = await postJson(fetchImpl, `${String(baseUrl).replace(/\/+$/, "")}${EP_ENT_USAGE}`, cred, timeoutMs);
  if (res.status >= 400) throw Object.assign(new Error(`ent usage http ${res.status}`), { status: res.status });
  const packs = Array.isArray(json?.user_entitlement_pack_list) ? json.user_entitlement_pack_list : [];
  let totalCredits = 0;
  for (const p of packs) totalCredits += Number(p?.entitlement_base_info?.quota?.credits_limit) || 0;
  return { totalCredits, isCreditsBilling: Boolean(json?.is_credits_billing), packCount: packs.length };
}
