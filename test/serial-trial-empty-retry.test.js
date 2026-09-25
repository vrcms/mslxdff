import { test } from "node:test";
import assert from "node:assert/strict";
import { runSerialTrial } from "../src/chat-pipeline/serial-trial.js";
import { isEmptyTurnError } from "../src/routes/chat/relay-pipeline.js";

const EMPTY_ERR = { model: "m", upstream: null, status: 502, message: "EMPTY_MODEL_RESPONSE: upstream returned 200 with no content — retry or rephrase" };

function baseCtx(over = {}) {
  return {
    order: ["m"], reqId: "r1", requested: "m",
    body: { stream: false, model: "m", messages: [{ role: "user", content: "hi" }] },
    hops: 0, useAuto: false, lockModel: "", plugins: [],
    auto: null, upstream: over.upstream, peers: null, groups: null, bus: null, token: "t",
    canFallback: false, canForwardPeers: false,
    perf0: 0, stages: [], mark: () => {}, evt: over.evt || (() => {}),
    logCall: () => {}, logError: () => {}, done: null, handlerCtx: {},
    res: {}, startedAt: Date.now(), logs: null, shareKeys: {},
  };
}

function withEnv(env, fn) {
  const prev = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; process.env[k] = env[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test("isEmptyTurnError: 只认 502 + EMPTY_MODEL_RESPONSE 前缀", () => {
  assert.equal(isEmptyTurnError(EMPTY_ERR), true);
  assert.equal(isEmptyTurnError({ status: 502, message: "stream timed out after 1ms" }), false);
  assert.equal(isEmptyTurnError({ status: 429, message: "EMPTY_MODEL_RESPONSE: x" }), false);
  assert.equal(isEmptyTurnError(null), false);
});

test("空转重试：首次空转→暂停→同模型重拉→成功", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_RETRY_DELAY_MS: "10" }, async () => {
    let chats = 0;
    const relays = [];
    const events = [];
    const upstream = { chat: async () => { chats++; return { status: 200 }; } };
    const localRelay = async () => {
      relays.push(1);
      if (relays.length === 1) return { handled: false, upRes: null, lastErr: { ...EMPTY_ERR } };
      return { handled: true };
    };
    const r = await runSerialTrial(
      baseCtx({ upstream, evt: (n, d) => events.push({ n, d }) }),
      { localRelay, exhaustedAll: async () => ({ done: true }) },
    );
    assert.equal(r.done, true, "重试后成功应终结");
    assert.equal(chats, 2, "上游应被拉两次（首次+重试）");
    assert.equal(relays.length, 2, "relay 应跑两次");
    assert.ok(events.some((e) => e.n === "empty-turn-retry"), "应打 empty-turn-retry 事件");
  });
});

test("空转重试耗尽：默认 2 次重试后交回（共 3 次上游）", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_RETRY_DELAY_MS: "10" }, async () => {
    let chats = 0;
    const upstream = { chat: async () => { chats++; return { status: 200 }; } };
    const localRelay = async () => ({ handled: false, upRes: null, lastErr: { ...EMPTY_ERR } });
    const r = await runSerialTrial(baseCtx({ upstream }), { localRelay, exhaustedAll: async () => ({ done: true }) });
    assert.equal(r.done, true, "耗尽后走 peers/groups（空）终结");
    assert.equal(chats, 3, "默认 1+2=3 次上游");
  });
});

test("MSLXDFF_EMPTY_TURN_RETRIES=0：关闭重试回旧行为", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_RETRIES: "0", MSLXDFF_EMPTY_TURN_RETRY_DELAY_MS: "10" }, async () => {
    let chats = 0;
    const upstream = { chat: async () => { chats++; return { status: 200 }; } };
    const localRelay = async () => ({ handled: false, upRes: null, lastErr: { ...EMPTY_ERR } });
    await runSerialTrial(baseCtx({ upstream }), { localRelay, exhaustedAll: async () => ({ done: true }) });
    assert.equal(chats, 1, "关闭时只拉一次上游");
  });
});

test("非空转失败不重试：500 直走原有路径", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_RETRY_DELAY_MS: "10" }, async () => {
    let chats = 0;
    const upstream = { chat: async () => { chats++; return { status: 200 }; } };
    const localRelay = async () => ({ handled: false, upRes: null, lastErr: { model: "m", status: 502, message: "stream timed out after 1ms" } });
    await runSerialTrial(baseCtx({ upstream }), { localRelay, exhaustedAll: async () => ({ done: true }) });
    assert.equal(chats, 1, "超时失败不触发空转重试");
  });
});
