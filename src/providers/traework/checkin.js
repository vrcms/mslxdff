// traework 签到/积分（照抄 traework2api internal/upstream/client.go Checkin* + UserEntUsage）。
import { UG_HOST, EP_CHECKIN_STATUS, EP_CHECKIN_CLAIM, EP_ENT_USAGE } from "./constants.js";
import { ugHeaders } from "./headers.js";
import { compatFetch, timeoutSignal } from "../../compat.js";

async function postJson(fetchImpl, url, cred, timeoutMs = 15000) {
  const res = await fetchImpl(url, { method: "POST", headers: ugHeaders(cred), body: "{}", signal: timeoutSignal(timeoutMs) });
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

export async function checkinClaim({ cred, baseUrl = UG_HOST, fetchImpl = compatFetch, timeoutMs = 15000 } = {}) {
  const { res } = await postJson(fetchImpl, `${String(baseUrl).replace(/\/+$/, "")}${EP_CHECKIN_CLAIM}`, cred, timeoutMs);
  if (res.status >= 400) throw Object.assign(new Error(`checkin claim http ${res.status}`), { status: res.status });
  return { ok: true };
}

// 积分：ide_user_ent_usage 的 credits_limit 求和。
export async function entUsage({ cred, baseUrl = UG_HOST, fetchImpl = compatFetch, timeoutMs = 15000 } = {}) {
  const { res, json } = await postJson(fetchImpl, `${String(baseUrl).replace(/\/+$/, "")}${EP_ENT_USAGE}`, cred, timeoutMs);
  if (res.status >= 400) throw Object.assign(new Error(`ent usage http ${res.status}`), { status: res.status });
  const packs = json?.user_entitlement_pack_list;
  if (!Array.isArray(packs)) return { remain: 0, isCreditsBilling: Boolean(json?.is_credits_billing) };
  let remain = 0;
  for (const p of packs) remain += Number(p?.entitlement_base_info?.quota?.credits_limit) || 0;
  return { remain, isCreditsBilling: Boolean(json?.is_credits_billing) };
}
