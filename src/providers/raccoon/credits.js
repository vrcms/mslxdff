// raccoon 积分：余额五分项查询 + 登录奖励领取（幂等，判据只认账单）。
// 这家是**积分制**，三种积分来源的性质（2026-10-10 账单流水实测 + 参考实现双向取证）：
//   · 新人注册礼包 3000 —— 注册时服务端自动发，**无端点可领**
//   · 每日积分发放 300 —— 每天服务端自动发，**当天 23:59:59 清零**（账单里有 `daily_expire`），也**无端点可领**
//   · 桌面端登录奖励 3000 —— **每号一次性**，走 `POST /desktop/v1/login/points/grant`，唯一需要领的
// ⚠ 上游对「已经领过」的重复请求**照样回 code:0**，但积分一分不到账 —— 所以 `code:0` 绝不能当成功凭据，
//   必须用账单流水裁决（见 claimRaccoonLoginReward）。谎报成功会让 daemon/CLI 输出假到账，比报错更坏。
import {
  RACCOON_LOGIN_REWARD_EVENT_NAME,
  RACCOON_LOGIN_REWARD_POINTS,
  RACCOON_REQUEST_TIMEOUT_MS,
  raccoonBalanceUrl,
  raccoonBillsUrl,
  raccoonLoginGrantUrl,
} from "./const.js";
import { raccoonAuthHeaders } from "./headers.js";
import { parseRaccoonEnvelope, raccoonEnvelopeText } from "./envelope.js";

const num = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return undefined;
};

async function request(url, { credential, fetchImpl = fetch, env = process.env, method = "GET", body, timeoutMs = RACCOON_REQUEST_TIMEOUT_MS } = {}) {
  const res = await fetchImpl(url, {
    method,
    headers: raccoonAuthHeaders(credential, { env }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let parsed;
  try {
    parsed = await res.json();
  } catch {
    throw new Error(`raccoon: 响应不是 JSON（HTTP ${res.status}）`);
  }
  return parseRaccoonEnvelope(parsed, res.status);
}

/** 余额五分项（缺项即省略，合计优先取上游的 available_points）。 */
export function parseRaccoonBalance(data) {
  const src = typeof data === "object" && data !== null ? data : {};
  const available = num(src.available_points);
  const reward = num(src.reward_points);
  const daily = num(src.daily_points);
  const topup = num(src.topup_points);
  const monthly = num(src.monthly_points);
  const items = [];
  if (reward !== undefined) items.push({ key: "reward", label: "奖励积分", value: reward });
  if (daily !== undefined) items.push({ key: "daily", label: "每日积分", value: daily });
  if (monthly !== undefined) items.push({ key: "monthly", label: "月度积分", value: monthly });
  if (topup !== undefined) items.push({ key: "topup", label: "充值积分", value: topup });
  const total = available !== undefined ? available : items.reduce((s, i) => s + i.value, 0);
  return { total, items };
}

export async function fetchRaccoonBalance(opts = {}) {
  const envelope = await request(raccoonBalanceUrl(), opts);
  if (envelope.code !== 0) {
    const err = new Error(`raccoon: 查询积分失败：${raccoonEnvelopeText(envelope)}`);
    err.code = envelope.code;
    err.status = envelope.status;
    throw err;
  }
  return parseRaccoonBalance(envelope.data);
}

/** 账单流水数组（上游把 list/items 两种形状都回过，容错取）。 */
function billsRows(data) {
  const list = Array.isArray(data?.list) ? data.list : Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : null;
  return list === null ? undefined : list.filter((x) => typeof x === "object" && x !== null);
}

/** 上游的时间字段可能是秒/毫秒数字或 ISO 串，统一成毫秒。 */
function billTimeMs(item) {
  const at = item.created_at ?? item.createdAt ?? item.time;
  if (typeof at === "number" && Number.isFinite(at)) return at > 1e12 ? at : at * 1000;
  if (typeof at === "string") {
    const ms = Date.parse(at);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

/**
 * 从账单里找「这个号历史上领过登录奖励没有」，返回 `{ points, at }` 或 undefined。
 * ⚠ 判据是**全历史**，不看日期窗口：登录奖励是每号一次性，用「今天」当窗口会让已领的号每天重新发请求，
 *   还会把"昨天领的"判成"没领过"。注册礼包同样是 `reward_grant`，所以 `event_name` 必须逐字比对。
 */
export function findLoginRewardInBills(data) {
  const rows = billsRows(data) || [];
  for (const item of rows) {
    if (item.biz_type !== "reward_grant") continue;
    if (item.event_name !== RACCOON_LOGIN_REWARD_EVENT_NAME) continue;
    const at = billTimeMs(item);
    return { points: num(item.points) ?? RACCOON_LOGIN_REWARD_POINTS, ...(at === undefined ? {} : { at }) };
  }
  return undefined;
}

/** 拉一次账单流水；网络/解析任何失败都返回 undefined（判定降级，不抛）。 */
async function readBills(opts) {
  try {
    const envelope = await request(raccoonBillsUrl(), opts);
    return envelope?.code === 0 ? billsRows(envelope.data) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 领取「桌面端登录奖励」（每号一次性）。返回三种非抛错结果之一：
 * - `{ claimed: true,  points }`  本次真到账（账单里出现了登录奖励那笔）
 * - `{ claimed: false, alreadyClaimed: true, points }`  历史已领，**且不会去碰写端点**
 * - `{ claimed: false, phantom: true,  points: 0 }`  上游回了 code:0 但账单没有这笔 —— 虚回，如实报未到账
 * - `{ claimed: false, unverified: true, points: 0 }`  账单查不动，无法确认到账（不猜、不谎报）
 * grant 请求本身失败（业务码非 0）且账单也查不到已领 → 抛错（如实透出）。
 */
export async function claimRaccoonLoginReward({ credential, fetchImpl = fetch, env = process.env, timeoutMs } = {}) {
  const opts = { credential, fetchImpl, env, timeoutMs };

  const before = await readBills(opts);
  const already = before === undefined ? undefined : findLoginRewardInBills(before);
  if (already) return { claimed: false, alreadyClaimed: true, points: already.points };

  let envelope;
  try {
    envelope = await request(raccoonLoginGrantUrl(), { ...opts, method: "POST", body: {} });
  } catch (error) {
    envelope = { code: -1, message: error?.message ?? String(error), status: 0, data: undefined };
  }

  // 无论上游怎么说，一律回账单复查 —— 这是唯一可信的到账凭据。
  const after = await readBills(opts);
  const landed = after === undefined ? undefined : findLoginRewardInBills(after);
  if (landed) {
    const points = num(envelope?.data?.points) ?? num(envelope?.data?.popup?.points) ?? landed.points ?? RACCOON_LOGIN_REWARD_POINTS;
    return { claimed: true, points };
  }
  if (after === undefined) return { claimed: false, unverified: true, points: 0 };
  if (envelope?.code === 0) return { claimed: false, phantom: true, points: 0 };

  const err = new Error(`raccoon: 领取登录积分失败：${raccoonEnvelopeText(envelope, "上游未返回原因")}`);
  err.code = envelope.code;
  err.status = envelope.status;
  throw err;
}

/**
 * claimRaccoonLoginReward 的结果 → 统一状态字。daemon 与 CLI 共用，避免两处各写一份分支后漂移。
 * claimed=真到账 · already=一次性礼包此前已领过（正常态） · phantom=上游回执成功但账单没这笔 ·
 * unverified=账单查不动，不下结论 · error=真失败。
 */
export function raccoonClaimStatus(r) {
  if (r?.claimed) return "claimed";
  if (r?.alreadyClaimed) return "already";
  if (r?.phantom) return "phantom";
  if (r?.unverified) return "unverified";
  return "error";
}
