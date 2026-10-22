// runCheckin：老入口 daily-check-in 返回 DISABLED 时，必须落到 campaigns 领真积分。
// 事故背景（2026-10-22 真机取证）：上游 cn 老入口已停用（status=DISABLED）但字段仍在返回，
// 每日 100 积分改由 campaigns 的 act-20261020-993（CLAIMABLE/CLAIM_BENEFIT）发放。
// 旧代码把 DISABLED 当活跃态去 claim → 拿 409 → 报「今日已领取」直接 return，永远走不到
// campaigns 兜底，两个 cn 号天天错过 100 积分（实测余额恒 0）。修后 DISABLED 豁免直落 campaigns。
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCheckin } from "../src/providers/qoder/checkin.js";

const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });

// 按 URL 路径分派的假上游：老入口 DISABLED，campaigns 有可领的真积分活动
function upstreamDisabled() {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    if (url.includes("/daily-check-in/status")) return json({ status: "DISABLED", rewardCredits: 100 });
    if (url.includes("/daily-check-in/claim")) return new Response("conflict", { status: 409 }); // 不该被调
    if (url.includes("/me/campaigns") && !url.includes("/claim")) {
      return json({ campaigns: [{ campaignId: "cid-993", campaignKey: "act-20261020-993", actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMABLE", benefit: { kind: "CREDITS", amount: 100 } }] });
    }
    if (url.includes("/claim")) return json({ status: "CLAIMED", benefit: { amount: 100 } });
    return new Response("nf", { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

test("DISABLED 老入口 → 落 campaigns 领真积分（不再谎报已领取）", async () => {
  const up = upstreamDisabled();
  const r = await runCheckin({ deviceToken: "dt", region: "cn", fetchImpl: up });
  assert.equal(r.ok, true);
  assert.equal(r.status, "claimed");
  assert.equal(r.amount, 100);
  assert.match(r.message, /领取成功 \+100/);
  // 关键：绝不能碰老入口的 claim（旧 bug 就是在这拿 409 谎报）
  assert.equal(up.calls.some((u) => u.includes("/daily-check-in/claim")), false);
});

test("DISABLED 老入口 + probeOnly → 干跑也落 campaigns 报可领（不谎报 claimable 于老入口）", async () => {
  const up = upstreamDisabled();
  const r = await runCheckin({ deviceToken: "dt", region: "cn", fetchImpl: up, probeOnly: true });
  assert.equal(r.ok, true);
  assert.equal(r.status, "claimable");
  assert.match(r.message, /act-20261020-993/);
});

test("老入口活跃(CLAIMABLE) → 仍走老入口领取（不回归）", async () => {
  const fn = async (url) => {
    if (url.includes("/daily-check-in/status")) return json({ status: "CLAIMABLE", rewardCredits: 100 });
    if (url.includes("/daily-check-in/claim")) return json({ rewardCredits: 100 });
    if (url.includes("/me/campaigns")) return json({ campaigns: [] });
    return new Response("nf", { status: 404 });
  };
  const r = await runCheckin({ deviceToken: "dt", region: "cn", fetchImpl: fn });
  assert.equal(r.status, "claimed");
  assert.equal(r.amount, 100);
});

test("老入口 CLAIMED → 报今日已领取（真领过，不谎报为可领）", async () => {
  const fn = async (url) => {
    if (url.includes("/daily-check-in/status")) return json({ status: "CLAIMED", rewardCredits: 100 });
    if (url.includes("/daily-check-in/claim")) return new Response("c", { status: 409 });
    if (url.includes("/me/campaigns")) return json({ campaigns: [] }); // 无新活动
    return new Response("nf", { status: 404 });
  };
  const r = await runCheckin({ deviceToken: "dt", region: "cn", fetchImpl: fn });
  assert.equal(r.ok, true);
  assert.equal(r.status, "already");
});
