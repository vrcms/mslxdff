import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkinOne, checkinAll } from "../src/providers/workbuddy/checkin.js";
import { isCheckinEnabled, getCheckinHour, todayKey, nextRunDelayMs, shouldCatchUp } from "../src/runtime/workbuddy-checkin.js";

function mockJson(obj, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(obj), headers: { get: () => "application/json" } };
}

describe("workbuddy checkin core", () => {
  it("code 0 算签到成功", async () => {
    const r = await checkinOne({ uid: "u1", at: "k", fetchImpl: async () => mockJson({ code: 0, msg: "ok" }) });
    assert.equal(r.ok, true);
    assert.equal(r.already, false);
  });

  it("code 10001 幂等算成功", async () => {
    const r = await checkinOne({ uid: "u1", at: "k", fetchImpl: async () => mockJson({ code: 10001, msg: "今天已签到，请明天再来" }) });
    assert.equal(r.ok, true);
    assert.equal(r.already, true);
  });

  it("401 标记 needRefresh 并试下一域", async () => {
    const calls = [];
    const r = await checkinOne({
      uid: "u1", at: "k",
      fetchImpl: async (url) => { calls.push(url); return mockJson({ code: 401 }, 401); },
    });
    assert.equal(r.ok, false);
    assert.equal(r.needRefresh, true);
    assert.equal(calls.length, 1); // 401 直接返回，不浪费第二域
  });

  it("首域失败切第二域", async () => {
    const r = await checkinOne({
      uid: "u1", at: "k",
      fetchImpl: async (url) => (String(url).includes("www.codebuddy.cn")
        ? mockJson({ code: 500, msg: "err" }, 500)
        : mockJson({ code: 0, msg: "ok" })),
    });
    assert.equal(r.ok, true);
    assert.match(r.url, /copilot\.tencent\.com/);
  });

  it("checkinAll 多账号逐个出 row", async () => {
    const rows = await checkinAll({
      accounts: [{ uid: "u1", at: "k1" }, { uid: "u2", at: "k2" }],
      fetchImpl: async () => mockJson({ code: 10001, msg: "已签到" }),
      concurrency: 2,
    });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.ok && r.already));
    assert.deepEqual(rows.map((r) => r.uid).sort(), ["u1", "u2"]);
  });
});

describe("workbuddy checkin scheduler", () => {
  it("默认开启，显式 0 关闭", () => {
    assert.equal(isCheckinEnabled({}), true);
    assert.equal(isCheckinEnabled({ MSLXDFF_WORKBUDDY_CHECKIN: "0" }), false);
    assert.equal(isCheckinEnabled({ MSLXDFF_WORKBUDDY_CHECKIN: "1" }), true);
  });

  it("签到小时默认 9，非法回退 9", () => {
    assert.equal(getCheckinHour({}), 9);
    assert.equal(getCheckinHour({ MSLXDFF_WORKBUDDY_CHECKIN_HOUR: "15" }), 15);
    assert.equal(getCheckinHour({ MSLXDFF_WORKBUDDY_CHECKIN_HOUR: "xx" }), 9);
    assert.equal(getCheckinHour({ MSLXDFF_WORKBUDDY_CHECKIN_HOUR: "25" }), 9);
  });

  it("todayKey 取本地日期", () => {
    const d = new Date(2026, 8, 4, 10, 0, 0);
    assert.equal(todayKey(d), "2026-09-04");
  });

  it("未到点返回到点延迟，已过返回明天", () => {
    const before = new Date(2026, 8, 4, 8, 0, 0);
    assert.equal(nextRunDelayMs(before, 9), 3600_000);
    const after = new Date(2026, 8, 4, 10, 0, 0);
    assert.equal(nextRunDelayMs(after, 9), 23 * 3600_000);
  });

  it("启动补签：过期且已过点才补", () => {
    const now = new Date(2026, 8, 4, 10, 0, 0);
    assert.equal(shouldCatchUp({ lastDate: "2026-09-03", now, hour: 9 }), true);
    assert.equal(shouldCatchUp({ lastDate: "2026-09-04", now, hour: 9 }), false);
    assert.equal(shouldCatchUp({ lastDate: "", now: new Date(2026, 8, 4, 8, 0, 0), hour: 9 }), false);
    assert.equal(shouldCatchUp({ lastDate: "", now, hour: 9 }), true);
  });
});
