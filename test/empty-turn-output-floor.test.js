import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSerialTrial } from "../src/chat-pipeline/serial-trial.js";
import { runAutoRace } from "../src/chat-pipeline/auto-race.js";
import { outputFloorCfg, withOutputFloor } from "../src/chat-pipeline/empty-turn.js";

// auto-race 胜出会 savePreferredModel：state 隔离（范例 chat-pipeline-engine-split.test.js）
process.env.MSLXDFF_STATE_FILE = join(mkdtempSync(join(tmpdir(), "mslxdff-floor-")), "state.json");

async function withEnv(env, fn) {
  const prev = {};
  // undefined = 显式删除该变量（测默认档位用），否则 Number("") 会被当成 0 把托底关掉
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

// cfg 类用例必须清场两个旋钮：本机 export 过 MSLXDFF_EMPTY_TURN_* 是常事，不清会假红
const CLEAR_FLOOR_ENV = { MSLXDFF_EMPTY_TURN_MIN_TOKENS: undefined, MSLXDFF_EMPTY_TURN_TINY_MAX: undefined };

// ---------- 配置解析（纯单测） ----------

test("outputFloorCfg 默认：托底 8192、门槛 64", async () => {
  await withEnv(CLEAR_FLOOR_ENV, () => {
    assert.deepEqual(outputFloorCfg(), { min: 8192, tiny: 64 });
  });
});

test("outputFloorCfg 可覆盖；MIN_TOKENS=0=关闭", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_MIN_TOKENS: "4096", MSLXDFF_EMPTY_TURN_TINY_MAX: "100" }, () => {
    assert.deepEqual(outputFloorCfg(), { min: 4096, tiny: 100 });
  });
  await withEnv({ MSLXDFF_EMPTY_TURN_MIN_TOKENS: "0", MSLXDFF_EMPTY_TURN_TINY_MAX: undefined }, () => {
    assert.equal(outputFloorCfg().min, 0, "0 显式关闭（空串=未设，不得被 Number('') 当成 0）");
  });
});

// ---------- 纯函数托底 ----------

test("max_completion_tokens=1 → 托到 8192（事故形状：full 日志铁证）", async () => {
  await withEnv(CLEAR_FLOOR_ENV, () => {
    const src = { model: "m", max_completion_tokens: 1 };
    const out = withOutputFloor(src);
    assert.equal(out.max_completion_tokens, 8192);
    assert.equal(src.max_completion_tokens, 1, "不改原对象（与 withRaisedMaxTokens 同约定）");
  });
});

test("max_tokens=32（<64）→ 托到 8192；≥64 原样同引用", async () => {
  await withEnv(CLEAR_FLOOR_ENV, () => {
    assert.equal(withOutputFloor({ max_tokens: 32 }).max_tokens, 8192);
    const ok = { max_tokens: 64 };
    assert.equal(withOutputFloor(ok), ok, "门槛值本身原样（低于才算算爆）");
    const big = { max_tokens: 8192 };
    assert.equal(withOutputFloor(big), big);
  });
});

test("没设额度不发明（发明归 MIN_RAISE_TO，首发不替客户端发明）", async () => {
  await withEnv(CLEAR_FLOOR_ENV, () => {
    const bare = { model: "m", messages: [] };
    assert.equal(withOutputFloor(bare), bare);
    const nullKey = { max_tokens: null };
    assert.equal(withOutputFloor(nullKey), nullKey, "null=没设，不是 0");
  });
});

test("MIN_TOKENS=0 关闭托底：原样透传", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_MIN_TOKENS: "0", MSLXDFF_EMPTY_TURN_TINY_MAX: undefined }, () => {
    const tiny = { max_completion_tokens: 1 };
    assert.equal(withOutputFloor(tiny), tiny);
  });
});

test("TINY_MAX 覆盖门槛", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_MIN_TOKENS: undefined, MSLXDFF_EMPTY_TURN_TINY_MAX: "100" }, () => {
    assert.equal(withOutputFloor({ max_tokens: 64 }).max_tokens, 8192, "64 < 100 → 托");
    const at = { max_tokens: 100 };
    assert.equal(withOutputFloor(at), at, "等于门槛原样");
  });
});

// ---------- 集成：两条 upstream.chat 出口都托 ----------

function serialCtx(over = {}) {
  return {
    order: ["m"], reqId: "r-floor", requested: "m",
    body: { stream: false, model: "m", messages: [{ role: "user", content: "hi" }] },
    hops: 0, useAuto: false, lockModel: "", plugins: [],
    auto: null, upstream: over.upstream, peers: null, groups: null, bus: null, token: "t",
    canFallback: false, canForwardPeers: false,
    perf0: 0, stages: [], mark: () => {}, evt: over.evt || (() => {}),
    logCall: () => {}, logError: () => {}, done: null, handlerCtx: {},
    res: {}, startedAt: Date.now(), logs: null, shareKeys: {},
  };
}

test("serial-trial：max_completion_tokens=1 的首发上游收到 8192，事件留 raiseFrom/raiseTo", async () => {
  await withEnv(CLEAR_FLOOR_ENV, async () => {
    const events = [];
    const seen = [];
    const ctx = serialCtx({
      upstream: { chat: async (p) => { seen.push(p); return { status: 200 }; } },
      evt: (n, d) => events.push({ n, d }),
    });
    ctx.body = { ...ctx.body, max_completion_tokens: 1 };
    await runSerialTrial(ctx, {
      localRelay: async () => ({ handled: true, wrotePayload: true }),
      exhaustedAll: async () => ({ done: true }),
    });
    assert.equal(seen[0].max_completion_tokens, 8192, "上游收到托底后的额度");
    const fl = events.find((e) => e.n === "output-floor");
    assert.ok(fl, "必须打 output-floor 事件（不掩盖客户端 bug）");
    assert.equal(fl.d.raiseFrom, 1);
    assert.equal(fl.d.raiseTo, 8192);
  });
});

function raceAutoSpy() {
  return {
    isCooling: () => false,
    statuses: () => ({}),
    recordOk: async () => {}, recordError: async () => {}, recordLatency: async () => {},
  };
}
function raceCtx(over = {}) {
  return {
    reqId: "r-race", requested: "auto",
    body: { model: "auto", messages: [{ role: "user", content: "hi" }], stream: false },
    policy: { shareKeys: {}, workbuddyUid: null }, shareKeys: {}, workbuddyUid: null,
    useAuto: true, lockModel: "", hops: 0, canFallback: true, canForwardPeers: false,
    perf0: 0, stages: [], mark: () => {}, evt: over.evt || (() => {}),
    logCall: () => {}, logError: () => {},
    handlerCtx: { reqId: "r-race", hops: 0, model: null },
    auto: raceAutoSpy(),
    upstream: over.upstream || { chat: async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } }) },
    plugins: [], peers: null, groups: null, bus: null, token: "tok", logs: null,
    res: {}, startedAt: Date.now(), order: ["ma", "mb"],
    ...over,
  };
}

test("auto-race：并发竞速各候选同样托底（model:auto 路径不漏）", async () => {
  await withEnv(CLEAR_FLOOR_ENV, async () => {
    const events = [];
    const seen = [];
    const ctx = raceCtx({
      upstream: { chat: async (f) => { seen.push(f); return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } }); } },
      evt: (n, d) => events.push({ n, d }),
    });
    ctx.body = { ...ctx.body, max_completion_tokens: 1 };
    const out = await runAutoRace(ctx, {
      localRelay: async () => ({ handled: true }),
      exhaustedAll: async () => { throw new Error("不许 exhausted"); },
    });
    assert.equal(out.done, true);
    assert.equal(seen.length, 2, "两个候选各一发");
    for (const f of seen) assert.equal(f.max_completion_tokens, 8192, "auto 竞速路径同样托底");
    const fls = events.filter((e) => e.n === "output-floor");
    assert.equal(fls.length, 2, "每个托底动作都留痕");
    for (const fl of fls) { assert.equal(fl.d.raiseFrom, 1); assert.equal(fl.d.raiseTo, 8192); }
  });
});

test("正常额度不出 output-floor 事件（不多话）", async () => {
  await withEnv(CLEAR_FLOOR_ENV, async () => {
    const events = [];
    const ctx = serialCtx({
      upstream: { chat: async () => ({ status: 200 }) },
      evt: (n, d) => events.push({ n, d }),
    });
    ctx.body = { ...ctx.body, max_tokens: 8192 };
    await runSerialTrial(ctx, {
      localRelay: async () => ({ handled: true, wrotePayload: true }),
      exhaustedAll: async () => ({ done: true }),
    });
    assert.equal(events.some((e) => e.n === "output-floor"), false);
  });
});

// ---------- 评审回修补测（P1-2 0不托 / P1-3 只加不减 / 双键 / 关闭档与 auto 集成） ----------

test("0/负数/非数字不托：0=上游默认值，抬成 8192 对默认 32000 的供应商是降额", async () => {
  await withEnv(CLEAR_FLOOR_ENV, () => {
    const zero = { max_tokens: 0 };
    assert.equal(withOutputFloor(zero), zero, "0 原样（与 withRaisedMaxTokens 的 cur>0 口径对齐）");
    const neg = { max_tokens: -1 };
    assert.equal(withOutputFloor(neg), neg);
    const junk = { max_tokens: "abc" };
    assert.equal(withOutputFloor(junk), junk, "NaN 不托");
  });
});

test("只加不减：MIN_TOKENS 小于客户端额度时不动客户端值", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_MIN_TOKENS: "16", MSLXDFF_EMPTY_TURN_TINY_MAX: "64" }, () => {
    assert.equal(withOutputFloor({ max_tokens: 32 }).max_tokens, 32, "32<64 但 32>16 → 保持 32");
    assert.equal(withOutputFloor({ max_tokens: 1 }).max_tokens, 16, "1<16 → 托到 16");
  });
});

test("MIN_TOKENS 负数=关（与 emptyTurnMinRaiseTo 口径一致）", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_MIN_TOKENS: "-1", MSLXDFF_EMPTY_TURN_TINY_MAX: undefined }, () => {
    const t = { max_completion_tokens: 1 };
    assert.equal(withOutputFloor(t), t);
  });
});

test("双键：只托算爆的键，事件 key 指认、raiseFrom/raiseTo 按被托键取值", async () => {
  await withEnv(CLEAR_FLOOR_ENV, async () => {
    const events = [];
    const seen = [];
    const ctx = serialCtx({
      upstream: { chat: async (x) => { seen.push(x); return { status: 200 }; } },
      evt: (n, d) => events.push({ n, d }),
    });
    ctx.body = { ...ctx.body, max_tokens: 8192, max_completion_tokens: 1 };
    await runSerialTrial(ctx, { localRelay: async () => ({ handled: true, wrotePayload: true }), exhaustedAll: async () => ({ done: true }) });
    assert.equal(seen[0].max_tokens, 8192, "正常键不动");
    assert.equal(seen[0].max_completion_tokens, 8192, "算爆键被托");
    const fl = events.find((e) => e.n === "output-floor");
    assert.equal(fl.d.key, "max_completion_tokens", "key 必须指认被托的键（否则 raiseFrom 记错）");
    assert.deepEqual([fl.d.raiseFrom, fl.d.raiseTo], [1, 8192]);
  });
});

test("serial 关闭档集成：MIN_TOKENS=0 透传 1 且无 output-floor 事件", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_MIN_TOKENS: "0", MSLXDFF_EMPTY_TURN_TINY_MAX: undefined }, async () => {
    const events = [];
    const seen = [];
    const ctx = serialCtx({
      upstream: { chat: async (x) => { seen.push(x); return { status: 200 }; } },
      evt: (n, d) => events.push({ n, d }),
    });
    ctx.body = { ...ctx.body, max_completion_tokens: 1 };
    await runSerialTrial(ctx, { localRelay: async () => ({ handled: true, wrotePayload: true }), exhaustedAll: async () => ({ done: true }) });
    assert.equal(seen[0].max_completion_tokens, 1, "关闭档透传 1");
    assert.equal(events.some((e) => e.n === "output-floor"), false, "关闭档不留事件");
  });
});

test("auto-race 正常额度：无 output-floor 事件", async () => {
  await withEnv(CLEAR_FLOOR_ENV, async () => {
    const events = [];
    const ctx = raceCtx({ evt: (n, d) => events.push({ n, d }) });
    ctx.body = { ...ctx.body, max_tokens: 8192 };
    await runAutoRace(ctx, { localRelay: async () => ({ handled: true }), exhaustedAll: async () => { throw new Error("不许 exhausted"); } });
    assert.equal(events.some((e) => e.n === "output-floor"), false);
  });
});
