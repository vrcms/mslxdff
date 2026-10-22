// fetchQuota 必须把「奖励池 addOnQuota」计入总额度。
// 事故背景（2026-10-22 真机取证）：Free 号 userQuota 恒 0/0，但领过签到奖励的号
// addOnQuota.remaining=100 仍有额度。旧版只读 userQuota → checkin --dry 把 2 个可用号
// 全报成「余额 0/0 credits（已耗尽）」，用户据此以为所有号都没额度。
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchQuota } from "../src/providers/qoder/checkin.js";

const quotaFetch = (json, status = 200) => async () =>
  new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });

test("fetchQuota: 只有 userQuota 时按基础池报", async () => {
  const r = await fetchQuota({
    deviceToken: "dt-x",
    region: "cn",
    fetchImpl: quotaFetch({
      isQuotaExceeded: true,
      userQuota: { total: 0, used: 0, remaining: 0, unit: "credits" },
    }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.remaining, 0);
  assert.equal(r.total, 0);
  assert.equal(r.exhausted, true);
  assert.equal(r.addOn, null);
});

test("fetchQuota: addOnQuota 有剩 → 合计进 total/remaining，不得报 0", async () => {
  // 真机 nick1188932827 号原始形态：userQuota 全 0，addOnQuota 剩 100
  const r = await fetchQuota({
    deviceToken: "dt-y",
    region: "cn",
    fetchImpl: quotaFetch({
      isQuotaExceeded: false,
      userQuota: { total: 0, used: 0, remaining: 0, unit: "credits" },
      addOnQuota: { total: 100, used: 1, remaining: 99, unit: "credits" },
    }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.total, 100);
  assert.equal(r.used, 1);
  assert.equal(r.remaining, 99);
  assert.equal(r.exhausted, false);
  // 分项保留，UI 想分开显示基础/奖励也行
  assert.deepEqual(r.base, { total: 0, used: 0, remaining: 0 });
  assert.deepEqual(r.addOn, { total: 100, used: 1, remaining: 99 });
});

test("fetchQuota: exhausted 以接口 isQuotaExceeded 为权威（不自推）", async () => {
  // 接口若明确说超限，即使数字没读全也不给翻案
  const r = await fetchQuota({
    deviceToken: "dt-z",
    region: "global",
    fetchImpl: quotaFetch({
      isQuotaExceeded: true,
      userQuota: { total: 0, used: 0, remaining: 0, unit: "credits" },
      addOnQuota: { total: 100, used: 100, remaining: 0, unit: "credits" },
    }),
  });
  assert.equal(r.exhausted, true);
  assert.equal(r.remaining, 0);
});

test("fetchQuota: 非 200 如实失败（不吞码）", async () => {
  const r = await fetchQuota({ deviceToken: "dt", region: "cn", fetchImpl: quotaFetch({}, 401) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});
