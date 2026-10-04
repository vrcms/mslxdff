import { test } from "node:test";
import assert from "node:assert/strict";
import { runSerialTrial } from "../src/chat-pipeline/serial-trial.js";
import { withEmptyNudge, emptyNudgeCfg } from "../src/chat-pipeline/empty-turn.js";

const EMPTY_ERR = { model: "m", upstream: null, status: 502, message: "EMPTY_MODEL_RESPONSE: upstream returned 200 with no content — retry or rephrase" };
const NUDGE = "如果你完成任务了，请简短的说：任务完成了。";

// 必须 async：同步版 `return fn()` 在 fn 首个 await 处就把 env 复原了，重试整段读的是环境残留，
// 测试只是侥幸没炸。undefined = 显式删除（与 serial-trial 版 helper 同一口径）。
async function withEnv(env, fn) {
  const prev = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

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

test("withEmptyNudge：默认话术追加为 user 消息，不改原对象", () => {
  const src = { model: "m", messages: [{ role: "user", content: "hi" }] };
  const out = withEmptyNudge(src, NUDGE);
  assert.notEqual(out, src);
  assert.equal(src.messages.length, 1);
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[1].role, "user");
  assert.equal(out.messages[1].content, NUDGE);
});

test("withEmptyNudge：无 messages / 已带同文案时原样返回", () => {
  const noMsg = { model: "m" };
  assert.equal(withEmptyNudge(noMsg, NUDGE), noMsg);
  const dup = { model: "m", messages: [{ role: "user", content: "hi" }, { role: "user", content: NUDGE }] };
  assert.equal(withEmptyNudge(dup, NUDGE), dup);
});

test("emptyNudgeCfg：默认开启默认话术；=0 关闭；自定义话术生效", async () => {
  await withEnv({ MSLXDFF_EMPTY_NUDGE: "", MSLXDFF_EMPTY_NUDGE_TEXT: "" }, () => {
    const c = emptyNudgeCfg();
    assert.equal(c.enabled, true);
    assert.equal(c.text, NUDGE);
  });
  await withEnv({ MSLXDFF_EMPTY_NUDGE: "0" }, () => {
    assert.equal(emptyNudgeCfg().enabled, false);
  });
  await withEnv({ MSLXDFF_EMPTY_NUDGE: "", MSLXDFF_EMPTY_NUDGE_TEXT: "done?" }, () => {
    const c = emptyNudgeCfg();
    assert.equal(c.enabled, true);
    assert.equal(c.text, "done?");
  });
});

test("末次空转重试才追问：前面的重试原样重拉", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_RETRY_STEPS: "[10,10]", MSLXDFF_EMPTY_TURN_RETRIES: "2", MSLXDFF_EMPTY_NUDGE: "", MSLXDFF_EMPTY_NUDGE_TEXT: "" }, async () => {
    const seen = [];
    const events = [];
    const upstream = { chat: async (payload) => { seen.push(payload); return { status: 200 }; } };
    const localRelay = async () => ({ handled: false, upRes: null, lastErr: { ...EMPTY_ERR } });
    await runSerialTrial(
      baseCtx({ upstream, evt: (n, d) => events.push({ n, d }) }),
      { localRelay, exhaustedAll: async () => ({ done: true }) },
    );
    assert.equal(seen.length, 3, "默认 1+2=3 次上游");
    assert.equal(seen[0].messages.length, 1, "首次原样");
    assert.equal(seen[1].messages.length, 1, "第一次重试仍原样");
    assert.equal(seen[2].messages.length, 2, "末次重试追加追问");
    assert.equal(seen[2].messages[1].content, NUDGE);
    const retries = events.filter((e) => e.n === "empty-turn-retry");
    assert.equal(retries.length, 2);
    assert.equal(retries[0].d.nudged, undefined);
    assert.equal(retries[1].d.nudged, 1);
  });
});

test("MSLXDFF_EMPTY_NUDGE=0：重试全程原样，不追问", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_RETRY_STEPS: "[10,10]", MSLXDFF_EMPTY_TURN_RETRIES: "2", MSLXDFF_EMPTY_NUDGE: "0" }, async () => {
    const seen = [];
    const upstream = { chat: async (payload) => { seen.push(payload); return { status: 200 }; } };
    const localRelay = async () => ({ handled: false, upRes: null, lastErr: { ...EMPTY_ERR } });
    await runSerialTrial(baseCtx({ upstream }), { localRelay, exhaustedAll: async () => ({ done: true }) });
    assert.equal(seen.length, 3);
    for (const p of seen) assert.equal(p.messages.length, 1);
  });
});
