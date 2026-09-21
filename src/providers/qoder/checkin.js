// qoder 签到/额度（移植 qoder2api checkin.go，修两处硬伤）：
//   ① 域名按区域选（Go 硬编码 openapi.qoder.com.cn → 国际号必然 401 TOKEN_EXPIRE）；
//   ② 活动类型放宽（Go 只认 CLAIM_BENEFIT，国际站活动是 VIEW_DETAILS 会被漏掉）。
// 认证只需 Bearer deviceToken + cosy-clienttype:10，无 COSY 签名、claim 空 body。
// 主流程：cn 走 daily-check-in（GET status → POST claim，409=今日已领）；
//         404/非 200 → 回落 campaigns（GET /sash/api/v1/me/campaigns → POST .../{id}/claim）。
// Note: 域名必须按每号 region 选（两站账号不通用），默认只领 CLAIM_BENEFIT — 见 .agents/notes/implemented/feature/2026-09-21-qoder-checkin-region-endpoints.md
import { EP_CAMPAIGNS, EP_CHECKIN_STATUS, EP_CHECKIN_CLAIM, EP_QUOTA, openapiBase, normalizeRegion } from "./constants.js";
import { compatFetch, timeoutSignal } from "../../compat.js";

export function checkinHeaders(deviceToken) {
  return {
    authorization: "Bearer " + String(deviceToken || ""),
    accept: "application/json",
    "accept-language": "zh-CN",
    "user-agent": "Qoder",
    "cosy-clienttype": "10",
  };
}

async function call(fetchImpl, region, path, { method = "GET", deviceToken, body, timeoutMs = 20000 } = {}) {
  const base = openapiBase(region);
  const headers = checkinHeaders(deviceToken);
  const init = { method, headers, signal: timeoutSignal(timeoutMs) };
  if (method !== "GET") {
    headers.origin = base;
    if (body !== undefined) init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetchImpl(base + path, init);
  } catch (e) {
    return { status: 0, json: null, text: "", error: String(e?.message || e).slice(0, 200) };
  }
  const text = await res.text().catch(() => "");
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch {} }
  return { status: res.status, json, text };
}

export function listCampaigns({ deviceToken, region, fetchImpl = compatFetch, timeoutMs } = {}) {
  return call(fetchImpl, region, EP_CAMPAIGNS, { deviceToken, timeoutMs });
}

export function claimCampaign({ deviceToken, region, campaignId, fetchImpl = compatFetch, timeoutMs } = {}) {
  return call(fetchImpl, region, `${EP_CAMPAIGNS}/${campaignId}/claim`, { method: "POST", deviceToken, timeoutMs });
}

export function dailyCheckinStatus({ deviceToken, region, fetchImpl = compatFetch, timeoutMs } = {}) {
  return call(fetchImpl, region, EP_CHECKIN_STATUS, { deviceToken, timeoutMs });
}

export function dailyCheckinClaim({ deviceToken, region, fetchImpl = compatFetch, timeoutMs } = {}) {
  return call(fetchImpl, region, EP_CHECKIN_CLAIM, { method: "POST", deviceToken, body: {}, timeoutMs });
}

// 余额：/api/v2/quota/usage → userQuota{total,used,remaining,unit} + isQuotaExceeded
export async function fetchQuota({ deviceToken, region, fetchImpl = compatFetch, timeoutMs } = {}) {
  const r = await call(fetchImpl, region, EP_QUOTA, { deviceToken, timeoutMs });
  if (r.status !== 200) return { ok: false, status: r.status, error: r.error || r.text.slice(0, 160) };
  const q = r.json?.userQuota || {};
  return {
    ok: true,
    total: Number(q.total) || 0,
    used: Number(q.used) || 0,
    remaining: Number(q.remaining) || 0,
    unit: String(q.unit || "credits"),
    exhausted: Boolean(r.json?.isQuotaExceeded),
  };
}

// 选活动：优先 CLAIM_BENEFIT（真积分），allowPromo 时也认 VIEW_DETAILS 等促销条目。
export function pickCampaign(campaigns, { allowPromo = false } = {}) {
  const list = Array.isArray(campaigns) ? campaigns : [];
  let benefit = null;
  let promo = null;
  let claimed = false;
  for (const c of list) {
    if (c?.claimStatus === "CLAIMED") claimed = true;
    if (c?.claimStatus !== "CLAIMABLE") continue;
    if (c?.actionType === "CLAIM_BENEFIT") benefit = benefit || c;
    else if (allowPromo) promo = promo || c;
  }
  return { target: benefit || promo, claimed };
}

// 单账号签到：返回 { ok, status: claimed|already|no_campaign|error, amount, streak, ... }
export async function runCheckin({ deviceToken, region, fetchImpl = compatFetch, allowPromo = false, probeOnly = false, timeoutMs } = {}) {
  const reg = normalizeRegion(region);
  const r = {
    region: reg, ok: false, status: "error", message: "", amount: 0,
    streak: 0, totalDays: 0, totalCredits: 0, reward: 0,
  };
  if (!deviceToken) { r.message = "无 device token（先 mslxdff -provider qoder login）"; return r; }

  const st = await dailyCheckinStatus({ deviceToken, region: reg, fetchImpl, timeoutMs });
  if (st.status === 200 && st.json?.status) {
    r.streak = Number(st.json.currentStreakDays) || 0;
    r.totalDays = Number(st.json.totalClaimDays) || 0;
    r.totalCredits = Number(st.json.totalRewardCredits) || 0;
    r.reward = Number(st.json.rewardCredits) || 0;
  }
  if (st.status === 401) { r.message = `device token 失效（HTTP 401）：请重新 mslxdff -provider qoder login`; return r; }

  // 干跑：只报状态，不发任何 claim 请求
  if (probeOnly && st.status === 200 && st.json?.status) {
    r.ok = true;
    r.status = st.json.status === "CLAIMED" ? "already" : "claimable";
    r.message = `干跑：status=${st.json.status} 每日奖励 ${r.reward}`;
    return r;
  }
  // 主流程：daily-check-in（国内站）
  if (st.status === 200 && st.json?.status) {
    const claim = await dailyCheckinClaim({ deviceToken, region: reg, fetchImpl, timeoutMs });
    if (claim.status === 409) { r.ok = true; r.status = "already"; r.message = "今日已领取"; return r; }
    if (claim.status === 200) {
      r.ok = true; r.status = "claimed";
      r.amount = Number(claim.json?.rewardCredits) || r.reward || 0;
      r.streak += 1; r.totalDays += 1; r.totalCredits += r.amount;
      r.message = `签到成功 +${r.amount}`;
      return r;
    }
    // 其它错误 → 保留统计，回落 campaigns
  }

  const list = await listCampaigns({ deviceToken, region: reg, fetchImpl, timeoutMs });
  if (list.status === 401) { r.message = "device token 失效（HTTP 401）：请重新 mslxdff -provider qoder login"; return r; }
  if (list.status !== 200) {
    r.message = `查询活动失败 HTTP ${list.status || "-"}: ${String(list.error || list.text).slice(0, 160)}`;
    return r;
  }
  const { target, claimed } = pickCampaign(list.json?.campaigns, { allowPromo });
  if (probeOnly) {
    r.ok = true; r.status = target ? "claimable" : "no_campaign";
    r.message = target
      ? `干跑：可领 ${target.actionType} ${target.campaignKey || ""}`.trim()
      : (claimed ? "干跑：今日已领取" : "干跑：无可用签到活动");
    return r;
  }
  if (!target) {
    r.ok = true; r.status = "no_campaign";
    r.message = claimed ? "今日已领取" : "无可用签到活动";
    return r;
  }
  const claim = await claimCampaign({ deviceToken, region: reg, campaignId: target.campaignId, fetchImpl, timeoutMs });
  if (claim.status !== 200 || claim.json?.status !== "CLAIMED") {
    r.message = `领取失败 HTTP ${claim.status || "-"}: ${String(claim.error || claim.text).slice(0, 160)}`;
    return r;
  }
  r.ok = true;
  r.amount = Number(claim.json?.benefit?.amount) || 0;
  r.expiresAt = String(claim.json?.expiresAt || "");
  r.campaignKey = String(target.campaignKey || "");
  if (claim.json?.replayed) { r.status = "already"; r.message = "今日已领取（幂等返回）"; }
  else {
    r.status = "claimed";
    r.message = r.amount > 0 ? `领取成功 +${r.amount} ${r.campaignKey}`.trim() : `领取成功 ${r.campaignKey}`.trim();
  }
  return r;
}
