// codearts 每日签到领积分（`/v1/ops/*`）—— 与 `claimBenefit` 的「模型 Token 福利」是**两本账**。
// 协议三方交叉验证：HITZY2002/codearts2api `internal/upstream/checkin.go`（Go）、
// L0NE-6/CodeArts-Daily `codearts_daily.py`（青龙）、anye-99·gurio-wine `src/codearts-credits.ts`（TS）。
// 现网取证 2026-10-24：`GET /v1/ops/delivery?channel=IDE` → 4 个活动，`#1 USER_LOGIN` 每日 1000 积分。
// 字段坑：`campaignId` 是**数字**、积分字段叫 **`benefitAmount`**、不可领取时 `status` 是 **`null`**。
import { SNAP_BASE } from "./const.js";
import { compatFetch, timeoutSignal } from "../../compat.js";
import { signRequest } from "./sign.js";

/** 活动列表/领取/确认的渠道标识（声明请求来自 IDE 形态；官方文档与两个参考实现同值）。 */
export const OPS_CHANNEL = "IDE";
/** ops 路由需要的 Agent-Type；值错会 `TM.00001001`（空→未找到合法可路由 api）。 */
export const OPS_AGENT_TYPE = "PromptCenter";
export const EP_OPS_DELIVERY = "/v1/ops/delivery";
export const EP_OPS_CLAIM = "/v1/ops/claim";
export const EP_OPS_CONFIRM = "/v1/ops/confirm";
export const EP_PACKAGE_INFO = "/snap-manager/v1/statistics/plugin";
export const snapBase = () => SNAP_BASE;

/** 只领这两类：每日签到 + 新用户注册礼（INVITE_USER / STUDENT_CERTIFIED 不是每日任务，不碰）。 */
const DAILY_TYPES = new Set(["USER_LOGIN", "NEW_USER_REGISTER"]);
/** 已到账态：这几个状态下绝不 claim（幂等只靠活动列表预检，上游没有业务码兜底）。 */
const DONE_STATUSES = new Set(["CONFIRMED", "CONSUMED"]);

/**
 * 解析活动列表。业务码非 0 或缺 `data.items` → 空表（不臆造契约）。
 * @returns {Array<{id:number,type:string,title:string,credit:number,unit:string,claimable:boolean,status:string}>}
 */
export function parseCreditCampaigns(payload) {
  const items = payload?.data?.items;
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const it of items) {
    const id = Number(it?.campaignId);
    if (!Number.isFinite(id)) continue; // campaignId 缺失的条目没法回传，丢掉
    out.push({
      id,
      type: String(it?.type || ""),
      title: String(it?.title || ""),
      // 对齐参考实现：`res.Credits = pendingTotalAmount || benefitAmount`（待结算优先，缺则取活动额）
      credit: Number(it?.pendingTotalAmount) || Number(it?.benefitAmount) || 0,
      unit: String(it?.benefitUnit || ""),
      claimable: it?.claimable === true,
      status: it?.status == null ? "" : String(it.status),
    });
  }
  return out;
}

/**
 * 由活动列表推出本次要做的写操作（纯函数，便于单测）。
 * 判据：只有 `claimable===true` 才 claim；`status==="CLAIMED"` 只补 confirm；已到账态零动作。
 * @returns {Array<{kind:"claim"|"confirm", id:number, credit:number, title:string}>}
 */
export function planCreditActions(campaigns) {
  const out = [];
  for (const c of Array.isArray(campaigns) ? campaigns : []) {
    if (!DAILY_TYPES.has(c?.type)) continue;
    if (c.unit && c.unit !== "CREDIT") continue; // 非积分账本不碰
    if (!Number.isFinite(c.id) || c.id <= 0) continue;
    if (c.status === "CLAIMED") { out.push({ kind: "confirm", id: c.id, credit: c.credit, title: c.title }); continue; }
    if (DONE_STATUSES.has(c.status)) continue;
    // 只有 ELIGIBLE + claimable 才 claim（参考实现：status 空 = 未获得活动资格；未知状态不臆造）
    if (c.status === "ELIGIBLE" && c.claimable) out.push({ kind: "claim", id: c.id, credit: c.credit, title: c.title });
  }
  return out;
}

// ─────────────────────────── HTTP 层（签名 + 写操作） ───────────────────────────

function credOf(account) {
  return { accessKeyId: account?.accessKeyId, secretAccessKey: account?.secretAccessKey, securityToken: account?.securityToken };
}

/**
 * 签名 ops 请求。只把 `content-type`（+ `sign.js` 自己加的 host/x-sdk-*）送进 canonical；
 * `agent-type` 与 `x-language` 必须**签名后追加**（参考实现口径：进 canonical 会 401）。
 */
async function opsRequest({ account, path, method = "GET", body, fetchImpl, baseUrl, timeoutMs = 20_000 } = {}) {
  const url = `${baseUrl || snapBase()}${path}`;
  const payload = body === undefined ? "" : JSON.stringify(body);
  const { headers: signedHeaders } = signRequest({
    method, url, headers: { "content-type": "application/json" }, body: payload, cred: credOf(account),
  });
  signedHeaders["agent-type"] = OPS_AGENT_TYPE;
  signedHeaders["x-language"] = "zh-cn";
  const doFetch = fetchImpl || compatFetch;
  let res;
  try {
    res = await doFetch(url, { method, headers: signedHeaders, ...(body === undefined ? {} : { body: payload }), signal: timeoutSignal(timeoutMs) });
  } catch (e) {
    return { status: 0, json: null, text: "", error: String(e?.message || e).slice(0, 200) };
  }
  const text = await res.text().catch(() => "");
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { /* 非 JSON：沿用 text 给调用方看 */ } }
  return { status: res.status, json, text };
}

/** 上游业务码非 0 即失败（`{code:4000,message:"invalid channel, group not found"}` 这种）。 */
const bizFailed = (r) => Boolean(r?.json) && r.json.code != null && Number(r.json.code) !== 0;
const errOf = (r) => r.error
  || (bizFailed(r) ? String(r.json.message || `code=${r.json.code}`).slice(0, 180)
    : (r.status === 200 ? "" : String(r.text || "").slice(0, 180)));

/** 读活动列表（只读）。 */
export async function fetchCreditCampaigns(opts = {}) {
  const r = await opsRequest({ ...opts, path: `${EP_OPS_DELIVERY}?channel=${OPS_CHANNEL}` });
  if (r.status !== 200) return { ok: false, status: r.status, campaigns: [], error: errOf(r), code: r.json?.code };
  if (bizFailed(r)) return { ok: false, status: 200, campaigns: [], error: errOf(r), code: r.json.code };
  return { ok: true, status: 200, campaigns: parseCreditCampaigns(r.json), error: "" };
}

/** 领取：`{campaignId, channel, idempotentKey}`（幂等键带毫秒时间戳，与参考实现同形状）。 */
export async function claimCreditCampaign({ campaignId, now = Date.now, ...opts } = {}) {
  const body = { campaignId, channel: OPS_CHANNEL, idempotentKey: `claim_${campaignId}_${now()}` };
  const r = await opsRequest({ ...opts, path: EP_OPS_CLAIM, method: "POST", body });
  return { ok: r.status === 200 && !bizFailed(r), status: r.status, json: r.json, error: errOf(r) };
}

/** 确认到账：`{campaignId}`。claim 之后无条件补这一步，否则状态停在 CLAIMED 不算到账。 */
export async function confirmCreditCampaign({ campaignId, ...opts } = {}) {
  const r = await opsRequest({ ...opts, path: EP_OPS_CONFIRM, method: "POST", body: { campaignId } });
  return { ok: r.status === 200 && !bizFailed(r), status: r.status, json: r.json, error: errOf(r) };
}

/**
 * 单账号签到：列表 → (claim → confirm) → **重读列表复查**。
 * 到账只认复查后的状态（raccoon/traework 同款纪律：只信回执就会谎报到账）。
 */
export async function runCheckin({ account, fetchImpl, baseUrl, timeoutMs, dry = false, now = Date.now } = {}) {
  const common = { account, fetchImpl, baseUrl, timeoutMs };
  const r = { account: account?.userId || null, ok: false, status: "error", dry: false, claimed: 0, credits: 0, actions: [], writes: [], campaigns: [], message: "" };
  const first = await fetchCreditCampaigns(common);
  r.campaigns = first.campaigns;
  if (!first.ok) { r.message = `查询活动失败 HTTP ${first.status || "-"}${first.error ? `：${first.error}` : ""}`; return r; }

  const actions = planCreditActions(first.campaigns);
  r.actions = actions;
  if (!actions.length) {
    const done = first.campaigns.some((c) => DAILY_TYPES.has(c.type) && DONE_STATUSES.has(c.status));
    r.ok = true;
    r.status = done ? "already" : "nothing";
    r.message = done ? "今日已领取（零写操作）" : "无可用签到活动";
    return r;
  }
  if (dry) {
    r.ok = true; r.dry = true; r.status = "claimable";
    r.message = `干跑：${actions.length} 项待领，未发写请求`;
    return r;
  }

  for (const a of actions) {
    if (a.kind === "claim") {
      const c1 = await claimCreditCampaign({ ...common, campaignId: a.id, now });
      r.writes.push({ kind: "claim", id: a.id, ok: c1.ok, status: c1.status, error: c1.error });
      if (!c1.ok) continue; // claim 失败则不 confirm（对齐参考实现：claim 错即返回）
    }
    const c2 = await confirmCreditCampaign({ ...common, campaignId: a.id });
    r.writes.push({ kind: "confirm", id: a.id, ok: c2.ok, status: c2.status, error: c2.error });
  }

  const after = await fetchCreditCampaigns(common);
  if (after.ok) r.campaigns = after.campaigns;
  const landed = (after.campaigns || []).filter((c) => actions.some((a) => a.id === c.id) && DONE_STATUSES.has(c.status));
  r.claimed = landed.length;
  r.credits = landed.reduce((s, c) => s + (c.credit || 0), 0);
  if (landed.length) {
    r.ok = true; r.status = "claimed";
    r.message = `签到到账 +${r.credits} 积分（${landed.length} 项：${landed.map((c) => `#${c.id}`).join(" ")}）`;
  } else {
    const bad = r.writes.find((w) => !w.ok);
    r.status = "not-landed";
    r.message = `写请求已发但复查仍未到账（不许当今天签过）：${bad ? `${bad.kind} HTTP ${bad.status || "-"} ${bad.error || ""}` : "重读活动列表后状态未变"}`.slice(0, 220);
  }
  return r;
}

/** 积分账本：取 `usageTotalPackageCredit` 的总额/已用/剩余（分类明细单列，**不累加**）。 */
export async function fetchCreditBalance(opts = {}) {
  const r = await opsRequest({ ...opts, path: EP_PACKAGE_INFO });
  if (r.status !== 200) return { ok: false, status: r.status, error: errOf(r) };
  const metrics = Array.isArray(r.json?.metrics) ? r.json.metrics : [];
  const num = (v) => Number(v) || 0;
  const pick = (name) => metrics.find((m) => m?.name === name);
  const creditOf = (m) => (m ? { total: num(m.package_credit_amount), used: num(m.package_credit_used), remain: num(m.package_credit_remain) } : null);
  const totalM = pick("usageTotalPackageCredit");
  const tokenM = pick("usageTokenChatMessages");
  return {
    ok: true, status: 200,
    total: num(totalM?.package_credit_amount), used: num(totalM?.package_credit_used), remain: num(totalM?.package_credit_remain),
    basic: creditOf(pick("usageBasicPackageCredit")),
    bonus: creditOf(pick("usageBonusPackageCredit")),
    onDemand: creditOf(pick("useOnDemandPackageCredit")) || creditOf(pick("usageOnDemandPackageCredit")),
    tokenUsage: num(tokenM?.usage_token_num), tokenPackages: num(tokenM?.package_token_amount),
    isCreditPackage: Boolean(totalM),
  };
}