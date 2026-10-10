// raccoon 积分：余额五分项查询 + 每日签到（幂等）。
// 这家是**积分制**——签到是唯一的日常回血途径（默认 3000 分），所以「已领取」必须判得出来，
// 不能靠上游报错来当业务状态（重复领取要显示「今日已领取」而不是错误堆栈）。
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

/** 从账单里找「今天是否已领过登录奖励」，返回已领积分数或 undefined。 */
export function findLoginRewardInBills(data, { now = Date.now() } = {}) {
  const list = Array.isArray(data?.list) ? data.list : Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    if (item.biz_type !== "reward_grant") continue;
    if (item.event_name !== RACCOON_LOGIN_REWARD_EVENT_NAME) continue;
    const at = item.created_at ?? item.createdAt ?? item.time;
    const ts = typeof at === "number" ? (at > 1e12 ? at : at * 1000) : typeof at === "string" ? Date.parse(at) : NaN;
    if (Number.isFinite(ts) && ts < dayStart.getTime()) continue;
    return num(item.points) ?? RACCOON_LOGIN_REWARD_POINTS;
  }
  return undefined;
}

/**
 * 领取每日登录积分。返回 `{ claimed, points }`：
 * - `claimed: true` 本次真领到；`claimed: false` 今日已领（不是错误）。
 * - 上游报错且账单里查不到已领记录 → 抛错（如实透出，不吞）。
 */
export async function claimRaccoonLoginReward({ credential, fetchImpl = fetch, env = process.env, timeoutMs, now = Date.now() } = {}) {
  const opts = { credential, fetchImpl, env, timeoutMs };
  let envelope;
  try {
    envelope = await request(raccoonLoginGrantUrl(), { ...opts, method: "POST", body: {} });
  } catch (error) {
    envelope = { code: -1, message: error?.message ?? String(error), status: 0, data: undefined };
  }

  if (envelope.code === 0) {
    const points = num(envelope.data?.points) ?? num(envelope.data?.popup?.points) ?? RACCOON_LOGIN_REWARD_POINTS;
    return { claimed: true, points };
  }

  // 上游可能把「今日已领」当业务错误回 —— 以账单为准判幂等，避免把常态当失败。
  let bills;
  try {
    bills = await request(raccoonBillsUrl(), opts);
  } catch {
    bills = undefined;
  }
  if (bills?.code === 0) {
    const already = findLoginRewardInBills(bills.data, { now });
    if (already !== undefined) return { claimed: false, points: already };
  }
  const err = new Error(`raccoon: 领取登录积分失败：${raccoonEnvelopeText(envelope, "上游未返回原因")}`);
  err.code = envelope.code;
  err.status = envelope.status;
  throw err;
}
