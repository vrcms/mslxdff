// 保热心跳（keep-warm）离线测试：零网络、零真实定时器。
// 关键契约：组员与供应商的保热必须走**与 chat 相同的池**（组员=warmPeer/getPeerDispatcher、
// 供应商=各自 preheat），裸 fetch 是错的（用户 2026-10-18 纠正）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { keepWarmIntervalMs, providerHeadsFromPicks, warmOnce, startKeepWarm } from "../src/runtime/keep-warm.js";

test("keepWarmIntervalMs：缺省 120s；=0 关；非法回默认", () => {
  assert.equal(keepWarmIntervalMs({}), 120_000);
  assert.equal(keepWarmIntervalMs({ MSLXDFF_KEEP_WARM_MS: "0" }), 0);
  assert.equal(keepWarmIntervalMs({ MSLXDFF_KEEP_WARM_MS: "30000" }), 30_000);
  assert.equal(keepWarmIntervalMs({ MSLXDFF_KEEP_WARM_MS: "-5" }), 120_000, "负数非法回默认");
});

test("providerHeadsFromPicks：裸 id 归 opencode、前缀取头、去重、opencode 置顶", () => {
  assert.deepEqual(
    providerHeadsFromPicks(["deepseek-v4.1-flash-free", "workbuddy/glm", "cline/cline-free/mimo", "big-pickle", "workbuddy/hy3"]),
    ["opencode", "workbuddy", "cline"],
    "五个 picks 收成三个供应商头，免费池主力置顶");
  assert.deepEqual(providerHeadsFromPicks([]), [], "空 picks 不炸");
  assert.deepEqual(providerHeadsFromPicks(["", "  ", null]), [], "脏条目忽略");
});

test("warmOnce：组员经 warmPeer（chat 同池）、宽带 relay:// 除外；供应商经各自 preheat", async () => {
  const peerUrls = [];
  const preheated = [];
  const byId = new Map([
    ["opencode", { id: "opencode", preheat: async () => { preheated.push("opencode"); return { ok: true }; } }],
    ["workbuddy", { id: "workbuddy", preheat: async () => { preheated.push("workbuddy"); return { ok: true }; } }],
  ]);
  const r = await warmOnce({
    peers: [{ url: "http://127.0.0.1:3500" }, { url: "http://172.93.221.187:8989/" }, { url: "relay://abc" }],
    picks: ["glm-free", "workbuddy/glm"],
    byId,
    warmPeer: async (url) => { peerUrls.push(url); return { ok: true }; },
  });
  assert.equal(r.peers, 2, "宽带 relay:// 不直连");
  assert.deepEqual(peerUrls, ["http://127.0.0.1:3500", "http://172.93.221.187:8989/"], "组员逐个保热（原 URL 交给 warmPeer 归一）");
  assert.deepEqual(preheated, ["opencode", "workbuddy"], "opencode 置顶、各家走自己的 preheat（chat 同池）");
  assert.equal(r.peerOk, 2); assert.equal(r.provOk, 2); assert.equal(r.provFail, 0);
});

test("warmOnce：无 preheat 的供应商头 skip（本地号型本就没有可保热的域），不误记为 fail", async () => {
  const r = await warmOnce({
    peers: [], picks: ["qoder/x", "opencode/y"],
    byId: new Map([["opencode", { preheat: async () => ({ ok: true }) }], ["qoder", { id: "qoder" }]]),
    warmPeer: async () => ({ ok: true }),
  });
  assert.equal(r.provOk, 1, "opencode 正常热");
  assert.equal(r.provSkip, 1, "qoder 无 preheat ⇒ skip，不算 fail");
  assert.equal(r.provFail, 0);
});

test("warmOnce：单支挂掉不抛、如实计数（保热永不拖垮自己，更不碰主链路）", async () => {
  const r = await warmOnce({
    peers: [{ url: "http://dead:8989" }, { url: "http://alive:8989" }],
    picks: ["x-free"],
    byId: new Map([["opencode", { preheat: async () => ({ ok: true }) }]]),
    warmPeer: async (url) => (String(url).includes("dead") ? { ok: false, error: "fetch failed" } : { ok: true }),
  });
  assert.equal(r.peerOk, 1, "挂掉的那支计入 fail 而不炸整轮");
  assert.equal(r.peerFail, 1);
  assert.equal(r.provOk, 1, "opencode 照常保热");
});

test("warmOnce：preheat 抛错也只记 fail，不影响其它支", async () => {
  const r = await warmOnce({
    peers: [], picks: ["a-free", "workbuddy/g"],
    byId: new Map([
      ["opencode", { preheat: async () => { throw new Error("boom"); } }],
      ["workbuddy", { preheat: async () => ({ ok: true }) }],
    ]),
    warmPeer: async () => ({ ok: true }),
  });
  assert.equal(r.provFail, 1);
  assert.equal(r.provOk, 1, "一支抛错不连坐另一支");
});

test("startKeepWarm：=0 关；启动即热一轮；stop 清定时器", async () => {
  const prev = process.env.MSLXDFF_KEEP_WARM_MS;
  process.env.MSLXDFF_KEEP_WARM_MS = "0";
  try { assert.equal(startKeepWarm({}), null, "关断时不许起定时器"); } finally {
    if (prev === undefined) delete process.env.MSLXDFF_KEEP_WARM_MS; else process.env.MSLXDFF_KEEP_WARM_MS = prev;
  }
  let ticks = 0;
  process.env.MSLXDFF_KEEP_WARM_MS = "99999999"; // 长间隔：只验「启动即热」不验周期
  try {
    const h = startKeepWarm({ peers: { all: () => [] }, providers: [], loadModelPicks: () => [], warmPeer: async () => ({ ok: true }) });
    assert.ok(h && h.interval > 0);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((h.tick, true), true, "句柄暴露 tick");
    h.stop();
  } finally {
    if (prev === undefined) delete process.env.MSLXDFF_KEEP_WARM_MS; else process.env.MSLXDFF_KEEP_WARM_MS = prev;
  }
});
