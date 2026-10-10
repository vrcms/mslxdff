// raccoon 积分与签到单测：五分项解析、签到成功、今日已领（幂等）、上游报错如实抛出。
// 全程注入 fetchImpl，不碰真实上游。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claimRaccoonLoginReward,
  fetchRaccoonBalance,
  findLoginRewardInBills,
  parseRaccoonBalance,
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

test("findLoginRewardInBills: 只认当日 reward_grant + 桌面端登录奖励", () => {
  const now = new Date("2026-10-10T12:00:00Z").getTime();
  const data = {
    list: [
      { biz_type: "chat", event_name: "桌面端登录奖励", points: 999 },
      { biz_type: "reward_grant", event_name: "别的活动", points: 888 },
      { biz_type: "reward_grant", event_name: "桌面端登录奖励", points: 3000, created_at: "2026-10-10T01:00:00Z" },
    ],
  };
  assert.equal(findLoginRewardInBills(data, { now }), 3000);
  const yesterday = {
    list: [{ biz_type: "reward_grant", event_name: "桌面端登录奖励", points: 3000, created_at: "2026-10-08T01:00:00Z" }],
  };
  assert.equal(findLoginRewardInBills(yesterday, { now }), undefined, "隔日的奖励不算今天已领");
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

test("claimRaccoonLoginReward: 成功 → claimed true + points", async () => {
  const r = await claimRaccoonLoginReward({
    credential: CRED,
    fetchImpl: async () => jsonResponse({ code: 0, data: { points: 3000 } }),
  });
  assert.equal(r.claimed, true);
  assert.equal(r.points, 3000);
});

test("claimRaccoonLoginReward: 上游把「今日已领」当业务错误 → 以账单为准判幂等，不抛错", async () => {
  const now = new Date("2026-10-10T12:00:00Z").getTime();
  const fetchImpl = async (url) => {
    if (String(url).includes("/login/points/grant")) return jsonResponse({ code: 400009, message: "今日已领取" });
    return jsonResponse({
      code: 0,
      data: { list: [{ biz_type: "reward_grant", event_name: "桌面端登录奖励", points: 3000, created_at: "2026-10-10T02:00:00Z" }] },
    });
  };
  const r = await claimRaccoonLoginReward({ credential: CRED, fetchImpl, now });
  assert.equal(r.claimed, false, "已领取是常态，不是错误");
  assert.equal(r.points, 3000);
});

test("claimRaccoonLoginReward: 上游报错且账单里查不到 → 如实抛出（不吞）", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("/login/points/grant")) return jsonResponse({ code: 500001, message: "服务异常" }, 500);
    return jsonResponse({ code: 0, data: { list: [] } });
  };
  await assert.rejects(
    () => claimRaccoonLoginReward({ credential: CRED, fetchImpl }),
    (e) => /领取登录积分失败/.test(e.message),
  );
});

test("claimRaccoonLoginReward: 上游不给 points 时回落默认 3000", async () => {
  const r = await claimRaccoonLoginReward({ credential: CRED, fetchImpl: async () => jsonResponse({ code: 0, data: {} }) });
  assert.equal(r.points, RACCOON_LOGIN_REWARD_POINTS);
});
