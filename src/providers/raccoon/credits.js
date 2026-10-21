// raccoon 积分：余额五分项查询 + 每日积分结算 + 登录奖励领取（幂等，判据只认账单）。
// 这家是**积分制**，四种积分来源的性质（2026-10-21 账单流水实测，此前 2026-10-10 的结论已被上游改版推翻）：
//   · 新人注册礼包 3000 —— 注册时服务端自动发，**无端点可领**
//   · 每日积分 500 —— 服务端按天挂账，**当天第一次访问 `/office/v3/setting_info` 才入账**
//                    （惰性结算，不是签到；入账即有效期到 T+6 的 23:59:59，即官方文案的「登录后延长至 7 天」）
//   · 桌面端登录奖励 3000 —— **每号一次性**，走 `POST /desktop/v1/login/points/grant`，唯一「领取」式接口
//   · 充值加油包 —— 用户自购
// ⚠ 2026-10-10 的旧结论「每日 300、当天 23:59:59 清零、无端点可领」**已过时**：现为 500 分、有效期 7 天、
//   有明确触发端点。别再照旧注释写代码。
// ⚠ 上游对「已经领过」的重复请求**照样回 code:0**，但积分一分不到账 —— 所以 `code:0` 绝不能当成功凭据，
//   必须用账单流水裁决（见 claimRaccoonLoginReward / claimRaccoonDailyPoints）。谎报成功会让 daemon/CLI 输出假到账，比报错更坏。
import {
  RACCOON_BILLS_PAGE_LIMIT,
  RACCOON_DAILY_GRANT_EVENT_NAME,
  RACCOON_LOGIN_REWARD_EVENT_NAME,
  RACCOON_LOGIN_REWARD_POINTS,
  RACCOON_REQUEST_TIMEOUT_MS,
  raccoonBalanceUrl,
  raccoonBillsUrl,
  raccoonLoginGrantUrl,
  raccoonOfficeSettingUrl,
} from "./const.js";
import { raccoonAuthHeaders } from "./headers.js";
import { confirmRaccoonSession } from "./login.js";
import { parseRaccoonEnvelope, raccoonEnvelopeText } from "./envelope.js";

const num = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return undefined;
};

/** 上游「新会话未确认」闸门码：先 POST /iam/confirm 再重试一次（与 chat.js 同款兜底）。 */
const IAM_CONFIRM_REQUIRED = 200901;

async function request(url, { credential, fetchImpl = fetch, env = process.env, method = "GET", body, timeoutMs = RACCOON_REQUEST_TIMEOUT_MS } = {}) {
  const once = async () => {
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
    return { res, envelope: parseRaccoonEnvelope(parsed, res.status) };
  };
  let { res, envelope } = await once();
  // 未确认会话闸门：确认一次后重试（老号 / CLI 直连都可能撞上，登录时已确认的号不会走到这）
  if (res.status === 400 && Number(envelope.code) === IAM_CONFIRM_REQUIRED) {
    if (await confirmRaccoonSession(credential, { fetchImpl, env })) {
      ({ res, envelope } = await once());
    }
  }
  return envelope;
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
 * - `{ claimed: false, alreadyClaimed: true, points }`  历史已领（账单查到，或上游回 `granted:false`）
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

  // 上游用 `data.granted` 直接回答「这次到底发没发」—— 这是比账单更权威的判据，优先采信。
  // `granted === false` ⇒ 本号此前已发过（一次性礼包），**不是「未到账」**。
  // 为什么不能只靠账单：重度使用的号（如 daemon 正在跑的那个）账单会被「对话消耗」刷满，
  //   分页窗口里根本翻不到那条陈年 reward_grant —— 此时只信账单就会把「早就领过」
  //   误报成「上游回执成功但账单查不到 → 未到账」（实测踩到，教训）。
  // 官方前端同款判据：granted 为真才弹「积分已到账」，为假就静默（见 app.asar grantDesktopLoginPoints 调用点）。
  if (envelope?.code === 0 && envelope.data?.granted === false) {
    return { claimed: false, alreadyClaimed: true, points: RACCOON_LOGIN_REWARD_POINTS };
  }

  // 未给 granted 判据（如上游老版本/测试桩）时回退账单复查 —— 到账凭据仍以账单为准。
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

// —— 每日积分（惰性结算，每日可重复触发；与上面的一次性登录奖励是两件事） ——

/** 从账单里找「今天那笔每日积分发放」，返回 `{ points, at, expireAt }` 或 undefined。 */
export function findDailyGrantInBills(data, now = Date.now()) {
  const rows = billsRows(data) || [];
  const today = localDateKey(now);
  for (const item of rows) {
    if (item.biz_type !== "daily_grant") continue;
    if (item.event_name && item.event_name !== RACCOON_DAILY_GRANT_EVENT_NAME) continue;
    // 归属日以 grant_at 为准（上游把它固定成当天 00:00），缺失时回落到 created_at
    const at = billTimeMs({ created_at: item.grant_at ?? item.created_at });
    if (at === undefined || localDateKey(at) !== today) continue;
    const expireAt = billTimeMs({ created_at: item.expire_at });
    return {
      points: num(item.points) ?? 0,
      at,
      ...(expireAt === undefined ? {} : { expireAt }),
    };
  }
  return undefined;
}

/** 本地日期键 YYYY-MM-DD —— 上游的日界按 +08:00 切，用本机时区判同一天即可。 */
function localDateKey(ms) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 拉当天账单（限量 200：够覆盖一天的重度对话消耗）。失败返回 undefined（判定降级，不抛）。 */
async function readBillsWide(opts) {
  try {
    const envelope = await request(raccoonBillsUrl(RACCOON_BILLS_PAGE_LIMIT), opts);
    return envelope?.code === 0 ? billsRows(envelope.data) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 结算当日每日积分（可每天重复调用，上游幂等）。
 *
 * 机制：`GET /api/web/office/v3/setting_info` 是服务端的惰性结算钩子 ——
 * 当天第一次访问它，服务端才把当天的每日积分真正挂账，并把有效期延到 T+6。
 * 不调用的话，`balance.daily_points` 一直是 0、账单里也压根没有 `daily_grant`（2026-10-21 实测）。
 *
 * 返回四种非抛错结果之一：
 * - `{ claimed: true,  points, expireAt }`  本次真结算入账（账单里出现了今天那笔）
 * - `{ claimed: false, alreadyToday: true, points, expireAt }`  今天已经结算过（正常态，不是失败）
 * - `{ claimed: false, unverified: true }`  账单查不动，无法确认（不猜、不谎报）
 * - 结算请求本身失败（业务码非 0 / 网络错误）→ 抛错（如实透出）
 */
export async function claimRaccoonDailyPoints({ credential, fetchImpl = fetch, env = process.env, timeoutMs, now = Date.now() } = {}) {
  const opts = { credential, fetchImpl, env, timeoutMs };

  // 先查账单：今天已经结算过就别再打结算端点（省一次请求，也让日志含义更准确）
  const before = await readBillsWide(opts);
  if (before !== undefined) {
    const hit = findDailyGrantInBills(before, now);
    if (hit) return { claimed: false, alreadyToday: true, points: hit.points, ...(hit.expireAt === undefined ? {} : { expireAt: hit.expireAt }) };
  }

  const envelope = await request(raccoonOfficeSettingUrl(), opts);
  if (envelope?.code !== 0) {
    const err = new Error(`raccoon: 每日积分结算失败：${raccoonEnvelopeText(envelope, "上游未返回原因")}`);
    err.code = envelope?.code;
    err.status = envelope?.status;
    throw err;
  }

  // 到账凭据只认账单：上游对已结算的重复请求同样回 code:0，回执不足以证明「这次发了」
  const after = await readBillsWide(opts);
  if (after === undefined) return { claimed: false, unverified: true, points: 0 };
  const landed = findDailyGrantInBills(after, now);
  if (!landed) {
    // 连打两次 code:0 都没在账单里看到今天这笔 → 上游改了结算规则或账单口径，如实说未确认，别谎报
    return { claimed: false, unverified: true, points: 0 };
  }
  return { claimed: true, points: landed.points, ...(landed.expireAt === undefined ? {} : { expireAt: landed.expireAt }) };
}

/**
 * claimRaccoonDailyPoints 的结果 → 统一状态字（daemon 与 CLI 共用）。
 * claimed=本次真入账 · already=今天已结算过（正常态） · unverified=账单查不动/没看到这笔，不下结论 · error=真失败。
 */
export function raccoonDailyStatus(r) {
  if (r?.claimed) return "claimed";
  if (r?.alreadyToday) return "already";
  if (r?.unverified) return "unverified";
  return "error";
}
