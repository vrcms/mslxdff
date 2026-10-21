// raccoon 积分单测：五分项解析 + 每日积分结算 + 登录奖励领取。
// 纪律：**只信账单，不信 code:0** —— 实测上游对重复领取照样回 code:0，但积分一分不到账。
// 全程注入 fetchImpl，不碰真实上游。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claimRaccoonDailyPoints,
  claimRaccoonLoginReward,
  fetchRaccoonBalance,
  findDailyGrantInBills,
  findLoginRewardInBills,
  parseRaccoonBalance,
  raccoonDailyStatus,
} from "../src/providers/raccoon/credits.js";
import { RACCOON_LOGIN_REWARD_POINTS } from "../src/providers/raccoon/const.js";

const jsonResponse = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj });
const CRED = { access_token: "tok" };

test("parseRaccoonBalance: 五分项齐全 + 合计取 available_points", () => {
  const b = parseRaccoonBalance({
    available_points: 1234,
    reward_points: 1000,
    daily_points: 200,
    topup_points: 30,
    monthly_points: 4,
  });
  assert.equal(b.total, 1234);
  assert.deepEqual(b.items.map((i) => i.key), ["reward", "daily", "monthly", "topup"]);
  assert.equal(b.items.find((i) => i.key === "daily").value, 200);
});

test("parseRaccoonBalance: 缺项即省略；无 available_points 时合计为分项之和", () => {
  const b = parseRaccoonBalance({ reward_points: 10, daily_points: 5 });
  assert.deepEqual(b.items.map((i) => i.key), ["reward", "daily"]);
  assert.equal(b.total, 15);
  assert.deepEqual(parseRaccoonBalance(null).items, []);
  assert.equal(parseRaccoonBalance(null).total, 0);
});

test("findLoginRewardInBills: biz_type 与 event_name 双条才算领过（注册礼包同为 reward_grant，不可混判）", () => {
  const now = new Date("2026-10-10T12:00:00Z").getTime();
  const data = {
    list: [
      { biz_type: "chat", event_name: "桌面端登录奖励", points: 999 },
      { biz_type: "reward_grant", event_name: "新人注册礼包", points: 3000 },
      { biz_type: "reward_grant", event_name: "桌面端登录奖励", points: 3000, created_at: "2026-09-01T01:00:00Z" },
    ],
  };
  const hit = findLoginRewardInBills(data, { now });
  assert.equal(hit.points, 3000);
  assert.equal(hit.at, Date.parse("2026-09-01T01:00:00Z"));
});

test("findLoginRewardInBills: 只有注册礼包 / 无账单 → 判未领", () => {
  const now = new Date("2026-10-10T12:00:00Z").getTime();
  const onlySignup = { list: [{ biz_type: "reward_grant", event_name: "新人注册礼包", points: 3000 }] };
  assert.equal(findLoginRewardInBills(onlySignup, { now }), undefined);
  assert.equal(findLoginRewardInBills({ list: [] }, { now }), undefined);
  assert.equal(findLoginRewardInBills(undefined, { now }), undefined);
});

test("fetchRaccoonBalance: 成功返回解析结果；非 0 code 抛错并带 code", async () => {
  const ok = await fetchRaccoonBalance({
    credential: CRED,
    fetchImpl: async () => jsonResponse({ code: 0, data: { available_points: 42 } }),
  });
  assert.equal(ok.total, 42);

  await assert.rejects(
    () => fetchRaccoonBalance({ credential: CRED, fetchImpl: async () => jsonResponse({ code: 200003, message: "登录已过期" }, 401) }),
    (e) => e.code === 200003 && e.status === 401,
  );
});

// —— 登录奖励（每号一次性）：判据一律走账单，绝不把上游 code:0 当到账 ——
const REWARD = { biz_type: "reward_grant", event_name: "桌面端登录奖励", points: 3000 };

/** 按「第几次查账单」切换返回的账单内容，用来模拟领取前后流水的变化；同时记录被请求过的 URL。 */
function billFetcher({ before, after, grant = { code: 0, data: { points: 3000 } }, urls = [] }) {
  return async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.includes("/login/points/grant")) return jsonResponse(grant);
    if (u.includes("/bills")) {
      const seen = urls.filter((x) => x.includes("/bills")).length;
      return jsonResponse({ code: 0, data: { list: (seen <= 1 ? before : after) || [] } });
    }
    return jsonResponse({ code: 0, data: {} });
  };
}

test("claimRaccoonLoginReward: 账单里已有登录奖励 → 判已领，且根本不再发 grant 请求", async () => {
  const urls = [];
  const r = await claimRaccoonLoginReward({ credential: CRED, fetchImpl: billFetcher({ before: [REWARD], after: [REWARD], urls }) });
  assert.equal(r.claimed, false);
  assert.equal(r.alreadyClaimed, true, "一次性礼包，领过就是领过");
  assert.equal(r.points, 3000);
  assert.ok(!urls.some((u) => u.includes("/grant")), "已领过就不该再打写端点");
});

test("claimRaccoonLoginReward: 上游回 code:0 但账单没多一笔 → 判虚回，不谎称领到（实测行为）", async () => {
  const urls = [];
  const r = await claimRaccoonLoginReward({ credential: CRED, fetchImpl: billFetcher({ before: [], after: [], urls }) });
  assert.equal(r.claimed, false, "code:0 不等于到账");
  assert.equal(r.phantom, true);
  assert.equal(r.points, 0);
  assert.ok(urls.some((u) => u.includes("/grant")), "虚回之前确实打过 grant");
});

test("claimRaccoonLoginReward: 上游回 code:0 且账单出现新笔 → 判真到账", async () => {
  const after = [{ ...REWARD, created_at: "2026-10-10T02:00:00Z" }];
  const r = await claimRaccoonLoginReward({ credential: CRED, fetchImpl: billFetcher({ before: [], after }) });
  assert.equal(r.claimed, true);
  assert.equal(r.points, 3000);
});

test("claimRaccoonLoginReward: grant 业务错且账单查无已领 → 如实抛出（不吞）", async () => {
  const fetchImpl = billFetcher({ before: [], after: [], grant: { code: 500001, message: "服务异常" } });
  await assert.rejects(
    () => claimRaccoonLoginReward({ credential: CRED, fetchImpl }),
    (e) => /领取登录积分失败/.test(e.message),
  );
});

test("claimRaccoonLoginReward: 上游不给 points 但账单确认到账 → 回落默认 3000", async () => {
  const after = [{ ...REWARD, created_at: "2026-10-10T02:00:00Z" }];
  const fetchImpl = billFetcher({ before: [], after, grant: { code: 0, data: {} } });
  const r = await claimRaccoonLoginReward({ credential: CRED, fetchImpl });
  assert.equal(r.claimed, true);
  assert.equal(r.points, RACCOON_LOGIN_REWARD_POINTS);
});

test("claimRaccoonLoginReward: 上游回 granted:false → 判已领，绝不误报成「未到账」（真实响应形状）", async () => {
  // 实测响应：`{"code":0,"message":"success","data":{"granted":false,"popup":null}}`
  // 重度使用的号账单会被对话消耗刷满、翻不到那条陈年 reward_grant，此时只信账单会把它
  // 误判成 phantom（上游回执成功但未到账）—— 这是踩过的坑，必须靠 granted 兜住。
  const urls = [];
  const r = await claimRaccoonLoginReward({
    credential: CRED,
    fetchImpl: billFetcher({ before: [], after: [], urls, grant: { code: 0, message: "success", data: { granted: false, popup: null } } }),
  });
  assert.equal(r.alreadyClaimed, true, "granted:false 就是「本号已发过」的权威判据");
  assert.equal(r.phantom, undefined, "不得误报成 phantom");
  assert.equal(r.points, RACCOON_LOGIN_REWARD_POINTS);
});

test("claimRaccoonLoginReward: granted:true 且账单确认到账 → 真到账，按 popup.points 报数", async () => {
  const after = [{ ...REWARD, created_at: "2026-10-10T02:00:00Z" }];
  const r = await claimRaccoonLoginReward({
    credential: CRED,
    fetchImpl: billFetcher({ before: [], after, grant: { code: 0, data: { granted: true, popup: { source: "desktop_login", points: 3000 } } } }),
  });
  assert.equal(r.claimed, true);
  assert.equal(r.points, 3000);
});

test("claimRaccoonLoginReward: 账单查询挂了 → 降级为未确认，不抛也不谎报", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("/bills")) throw new Error("network down");
    return jsonResponse({ code: 0, data: { points: 3000 } });
  };
  const r = await claimRaccoonLoginReward({ credential: CRED, fetchImpl });
  assert.equal(r.claimed, false);
  assert.equal(r.unverified, true, "查不到账就别说领到了");
});

test("findLoginRewardInBills: 全历史判据 —— 九月领的十月仍算已领（一次性礼包没有日界）", () => {
  const now = new Date("2026-10-10T12:00:00Z").getTime();
  const hit = findLoginRewardInBills({ list: [{ ...REWARD, created_at: "2026-09-01T08:00:00Z" }] }, { now });
  assert.ok(hit, "9 月领的，10 月依然算已领");
  assert.equal(hit.points, 3000);
});

// —— 每日积分（惰性结算，每天可重复触发） ——
// 真实响应形状（2026-10-21 账单实测）：{ biz_type: "daily_grant", event_name: "每日积分发放", points: 500,
//   created_at: "...T09:56:58+08:00", grant_at: "...T00:00:00+08:00", expire_at: "...T23:59:59+08:00" }
const DAILY = (grantAt, { points = 500, expireAt = "" } = {}) => ({
  biz_type: "daily_grant",
  event_name: "每日积分发放",
  points,
  grant_at: grantAt,
  created_at: grantAt,
  ...(expireAt ? { expire_at: expireAt } : {}),
});

test("findDailyGrantInBills: 只认当天的 grant_at —— 昨天那笔不算今天", () => {
  const now = new Date(2026, 9, 21, 12, 0, 0).getTime(); // 本地 2026-10-21 12:00
  const today = new Date(2026, 9, 21, 0, 0, 0);
  const yesterday = new Date(2026, 9, 20, 0, 0, 0);
  const hit = findDailyGrantInBills({ items: [DAILY(yesterday.toISOString()), DAILY(today.toISOString())] }, now);
  assert.equal(hit.points, 500);
  assert.equal(new Date(hit.at).getDate(), 21);
});

test("findDailyGrantInBills: 重度用号的账单被对话消耗刷满也能捞到今天那笔", () => {
  const now = new Date(2026, 9, 21, 12, 0, 0).getTime();
  const today = new Date(2026, 9, 21, 0, 0, 0).toISOString();
  const noise = Array.from({ length: 199 }, (_, i) => ({ biz_type: "desktop", event_name: "桌面端 LLM 对话消耗", points: -4, created_at: today }));
  const hit = findDailyGrantInBills({ items: [...noise, DAILY(today)] }, now);
  assert.equal(hit.points, 500, "噪声再多也要按 biz_type 过滤后找到它");
});

test("findDailyGrantInBills: 只有 daily_expire / 别的 event_name → 判今天没结算", () => {
  const now = new Date(2026, 9, 21, 12, 0, 0).getTime();
  const today = new Date(2026, 9, 21, 0, 0, 0).toISOString();
  assert.equal(findDailyGrantInBills({ items: [{ biz_type: "daily_expire", event_name: "每日积分到期清零", points: -500, created_at: today }] }, now), undefined);
  assert.equal(findDailyGrantInBills(undefined, now), undefined);
});

test("claimRaccoonDailyPoints: 今天已结算 → 判 alreadyToday，且不再打结算端点", async () => {
  const now = new Date(2026, 9, 21, 12, 0, 0).getTime();
  const today = new Date(2026, 9, 21, 0, 0, 0).toISOString();
  const urls = [];
  const r = await claimRaccoonDailyPoints({
    credential: CRED, now,
    fetchImpl: async (url) => {
      urls.push(String(url));
      return jsonResponse({ code: 0, data: { items: [DAILY(today)] } });
    },
  });
  assert.equal(r.claimed, false);
  assert.equal(r.alreadyToday, true);
  assert.equal(r.points, 500);
  assert.equal(raccoonDailyStatus(r), "already");
  assert.ok(!urls.some((u) => u.includes("setting_info")), "已结算就别再打结算钩子");
});

test("claimRaccoonDailyPoints: 结算后账单出现今天这笔 → 判真入账（带 expireAt）", async () => {
  const now = new Date(2026, 9, 21, 12, 0, 0).getTime();
  const today = new Date(2026, 9, 21, 0, 0, 0).toISOString();
  const expire = new Date(2026, 9, 27, 23, 59, 59).toISOString();
  let billsSeen = 0;
  const urls = [];
  const r = await claimRaccoonDailyPoints({
    credential: CRED, now,
    fetchImpl: async (url) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("setting_info")) return jsonResponse({ code: 0, message: "success", data: {} });
      billsSeen += 1;
      return jsonResponse({ code: 0, data: { items: billsSeen >= 2 ? [DAILY(today, { expireAt: expire })] : [] } });
    },
  });
  assert.equal(r.claimed, true);
  assert.equal(r.points, 500);
  assert.equal(r.expireAt, Date.parse(expire));
  assert.equal(raccoonDailyStatus(r), "claimed");
  assert.ok(urls.some((u) => u.includes("setting_info")), "该打结算钩子");
});

test("claimRaccoonDailyPoints: 结算回 code:0 但账单始终没有今天这笔 → 未确认，不谎报", async () => {
  const now = new Date(2026, 9, 21, 12, 0, 0).getTime();
  const r = await claimRaccoonDailyPoints({
    credential: CRED, now,
    fetchImpl: async (url) => (
      String(url).includes("setting_info")
        ? jsonResponse({ code: 0, message: "success", data: {} })
        : jsonResponse({ code: 0, data: { items: [] } })
    ),
  });
  assert.equal(r.claimed, false);
  assert.equal(r.unverified, true);
  assert.equal(raccoonDailyStatus(r), "unverified");
});

test("claimRaccoonDailyPoints: 结算端点业务错 → 如实抛出（不吞）", async () => {
  const now = new Date(2026, 9, 21, 12, 0, 0).getTime();
  const fetchImpl = async (url) => {
    if (String(url).includes("setting_info")) return jsonResponse({ code: 200003, message: "登录已过期" }, 401);
    return jsonResponse({ code: 0, data: { items: [] } });
  };
  await assert.rejects(
    () => claimRaccoonDailyPoints({ credential: CRED, now, fetchImpl }),
    (e) => /每日积分结算失败/.test(e.message) && e.code === 200003,
  );
});

test("claimRaccoonDailyPoints: 账单查询挂了 → 结算照做，结果降级为未确认（不抛）", async () => {
  const now = new Date(2026, 9, 21, 12, 0, 0).getTime();
  const r = await claimRaccoonDailyPoints({
    credential: CRED, now,
    fetchImpl: async (url) => {
      if (String(url).includes("setting_info")) return jsonResponse({ code: 0, data: {} });
      throw new Error("network down");
    },
  });
  assert.equal(r.claimed, false);
  assert.equal(r.unverified, true, "查不到账就别说结算成功了");
});
