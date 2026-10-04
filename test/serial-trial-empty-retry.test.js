import { test } from "node:test";
import assert from "node:assert/strict";
import { runSerialTrial } from "../src/chat-pipeline/serial-trial.js";
import { withRaisedMaxTokens, computeNextDelay, emptyRetryCfg, DEFAULT_EMPTY_TURN_STEPS } from "../src/chat-pipeline/empty-turn.js";
import { isEmptyTurnError } from "../src/routes/chat/relay-pipeline.js";

const EMPTY_ERR = { model: "m", upstream: null, status: 502, message: "EMPTY_MODEL_RESPONSE: upstream returned 200 with no content — retry or rephrase" };

const LADDER = { MSLXDFF_EMPTY_TURN_RETRY_STEPS: "[10,20,30]", MSLXDFF_EMPTY_TURN_RETRIES: "3" };

function baseCtx(over = {}) {
  return {
    order: ["m"], reqId: "r1", requested: "m",
    body: { stream: false, model: "m", messages: [{ role: "user", content: "hi" }] },
    hops: 0, useAuto: false, lockModel: "", plugins: [],
    auto: null, upstream: over.upstream, peers: null, groups: null, bus: null, token: "t",
    canFallback: false, canForwardPeers: false,
    perf0: 0, stages: [], mark: () => {}, evt: over.evt || (() => {}),
    logCall: over.logCall || (() => {}), logError: over.logError || (() => {}), done: null, handlerCtx: {},
    res: {}, startedAt: Date.now(), logs: null, shareKeys: {},
  };
}

async function withEnv(env, fn) {
  const prev = {};
  // undefined = 显式删除该变量（测默认档位用），否则 Number("") 会被当成 0 把重试关掉
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

const alwaysErr = async () => ({ handled: false, upRes: null, lastErr: { ...EMPTY_ERR } });

test("isEmptyTurnError: 只认 502 + EMPTY_MODEL_RESPONSE 前缀", () => {
  assert.equal(isEmptyTurnError(EMPTY_ERR), true);
  assert.equal(isEmptyTurnError({ status: 502, message: "stream timed out after 1ms" }), false);
  assert.equal(isEmptyTurnError({ status: 429, message: "EMPTY_MODEL_RESPONSE: x" }), false);
  assert.equal(isEmptyTurnError(null), false);
});

// ---------- 阶梯语义：配置解析（纯单测，不真等 2s/8s/30s） ----------

// cfg 类用例必须把三个旋钮全清场：本机 export 过 MSLXDFF_EMPTY_TURN_RETRIES 是常事，不清就会假红。
const CLEAR_EMPTY_TURN_ENV = { MSLXDFF_EMPTY_TURN_RETRY_STEPS: undefined, MSLXDFF_EMPTY_TURN_RETRIES: undefined, MSLXDFF_EMPTY_TURN_RETRY_DELAY_MS: undefined };

test("默认＝未设任何 env 也走阶梯 [2000,8000,30000] × 最多 3 次", async () => {
  await withEnv(CLEAR_EMPTY_TURN_ENV, () => {
    const cfg = emptyRetryCfg();
    assert.deepEqual(cfg.steps, [2000, 8000, 30000], "默认阶梯即用户定的 2s→8s→30s");
    assert.equal(cfg.max, 3, "重试上限默认跟随阶梯档数");
  });
});

test("自定义阶梯覆盖默认值", async () => {
  await withEnv({ ...CLEAR_EMPTY_TURN_ENV, MSLXDFF_EMPTY_TURN_RETRY_STEPS: "[500,1500,5000]" }, () => {
    const cfg = emptyRetryCfg();
    assert.deepEqual(cfg.steps, [500, 1500, 5000]);
    assert.equal(cfg.max, 3, "未显式给次数时，上限跟随档数");
  });
});

test("默认阶梯不可被原地改坏（污染即进程级默认值）", async () => {
  await withEnv(CLEAR_EMPTY_TURN_ENV, () => {
    const cfg = emptyRetryCfg();
    assert.throws(() => cfg.steps.push(1), "导出的默认阶梯必须冻结，否则一个调用方 sort/splice 就改坏全进程");
  });
});

test("MSLXDFF_EMPTY_TURN_RETRIES 显式值压过阶梯档数", async () => {
  await withEnv({ ...CLEAR_EMPTY_TURN_ENV, MSLXDFF_EMPTY_TURN_RETRY_STEPS: "[1000]", MSLXDFF_EMPTY_TURN_RETRIES: "5" }, () => {
    assert.equal(emptyRetryCfg().max, 5, "显式次数优先（超出档数按下标取模复用阶梯）");
  });
});

test("RETRIES 空串（.env 手滑）＝未设，绝不静默清零重试", async () => {
  await withEnv({ ...CLEAR_EMPTY_TURN_ENV, MSLXDFF_EMPTY_TURN_RETRIES: "" }, () => {
    assert.equal(emptyRetryCfg().max, 3, "空值必须按未设处理，否则 RETRIES= 手滑等于关掉整条恢复");
  });
});

test("逃生阀：显式 [] 回旧式固定延迟，且不因手滑关掉重试", async () => {
  await withEnv({ ...CLEAR_EMPTY_TURN_ENV, MSLXDFF_EMPTY_TURN_RETRY_STEPS: "[]" }, () => {
    const cfg = emptyRetryCfg();
    assert.equal(cfg.steps, null, "空数组 = 明确退回旧行为");
    assert.equal(cfg.delayMs, 2000, "旧默认 2s");
    assert.equal(cfg.max, 2, "旧默认 2 次");
  });
});

test("非法阶梯（语法错/含非正数/非数组）→ 告警恰好一次并按默认阶梯跑", async () => {
  const warns = [];
  const realWarn = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    for (const bad of ["not json at all!", "[2000,-5]", "123"]) {
      await withEnv({ ...CLEAR_EMPTY_TURN_ENV, MSLXDFF_EMPTY_TURN_RETRY_STEPS: bad }, () => {
        assert.deepEqual(emptyRetryCfg().steps, DEFAULT_EMPTY_TURN_STEPS, `非法值 ${bad} 必须落回默认阶梯，绝不清零重试`);
      });
    }
  } finally {
    console.warn = realWarn;
  }
  assert.equal(warns.length, 1, `三个坏值只许告警一次（实测 ${warns.length}）`);
  assert.match(warns[0], /MSLXDFF_EMPTY_TURN_RETRY_STEPS/);
});

test("上游 retryAfterSeconds 无顶会被拿捏：等待必须封顶（默认 60s）", async () => {
  const err = { message: "EMPTY_MODEL_RESPONSE upstream=上游供应商触发 retryAfterSeconds: 3600" };
  await withEnv(CLEAR_EMPTY_TURN_ENV, () => {
    assert.equal(computeNextDelay(0, [2000, 8000, 30000], err), 60000, "3600s → 封到默认顶，不挂 1 小时");
  });
  await withEnv({ ...CLEAR_EMPTY_TURN_ENV, MSLXDFF_EMPTY_TURN_MAX_WAIT_MS: "90000" }, () => {
    assert.equal(computeNextDelay(0, [2000], err), 90000, "顶可调");
  });
  await withEnv(CLEAR_EMPTY_TURN_ENV, () => {
    assert.equal(computeNextDelay(0, [120000], err), 120000, "用户自配的更大档照办（顶只约束上游能 imposed 的部分）");
  });
});

test("computeNextDelay：按档取阶梯，超出档数取模复用", () => {
  return withEnv({ MSLXDFF_EMPTY_TURN_RETRY_DELAY_MS: undefined }, () => {
    assert.equal(computeNextDelay(0, [2000, 8000, 30000], null), 2000);
    assert.equal(computeNextDelay(1, [2000, 8000, 30000], null), 8000);
    assert.equal(computeNextDelay(2, [2000, 8000, 30000], null), 30000);
    assert.equal(computeNextDelay(3, [2000, 8000], null), 8000, "第 4 次 → steps[3%2]=steps[1]");
    assert.equal(computeNextDelay(4, [2000, 8000], null), 2000, "第 5 次 → 回卷到第 1 档");
  });
});

test("computeNextDelay：retryAfterSeconds 把等待抬到不低于限流窗口（本次改动起因）", () => {
  const err = { message: "EMPTY_MODEL_RESPONSE upstream=上游供应商触发 retryAfterSeconds: 30" };
  return withEnv({ MSLXDFF_EMPTY_TURN_RETRY_DELAY_MS: undefined }, () => {
    assert.equal(computeNextDelay(0, [2000, 8000, 30000], err), 30000, "2s 档撞 30s 限流 → 抬到 30s");
    assert.equal(computeNextDelay(1, [2000, 8000], err), 30000, "8s 档同样抬到 30s");
    assert.equal(computeNextDelay(0, null, err), 30000, "旧固定延迟模式同样受钳位保护");
    assert.equal(computeNextDelay(0, [50000], err), 50000, "阶梯本身更大时不降回去");
  });
});

// ---------- 接线：空转重试真的走阶梯 ----------

test("空转重试：首次空转→暂停→同模型重拉→成功", async () => {
  await withEnv(LADDER, async () => {
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
    const retry = events.find((e) => e.n === "empty-turn-retry");
    assert.ok(retry, "应打 empty-turn-retry 事件");
    assert.equal(retry.d.delayMs, 10, "第一次用阶梯第 1 档");
    assert.equal(retry.d.step, 0, "阶梯模式下标可 grep");
  });
});

test("阶梯逐档生效：第 1/2/3 次分别用第 1/2/3 档", async () => {
  await withEnv(LADDER, async () => {
    const events = [];
    const upstream = { chat: async () => ({ status: 200 }) };
    await runSerialTrial(baseCtx({ upstream, evt: (n, d) => events.push({ n, d }) }), { localRelay: alwaysErr, exhaustedAll: async () => ({ done: true }) });
    const rs = events.filter((e) => e.n === "empty-turn-retry");
    assert.deepEqual(rs.map((e) => e.d.delayMs), [10, 20, 30], "逐档递增，不是固定值重复");
    assert.deepEqual(rs.map((e) => e.d.step), [0, 1, 2]);
    assert.deepEqual(rs.map((e) => e.d.waitedMs), [10, 30, 60], "waitedMs 是累计白等时长（累加器，不是次数×末档）");
  });
});

test("上游报 retryAfterSeconds 时，重试等待被抬到限流窗口", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_RETRY_STEPS: "[10,20,30]", MSLXDFF_EMPTY_TURN_RETRIES: "2" }, async () => {
    const events = [];
    let n = 0;
    const upstream = { chat: async () => ({ status: 200 }) };
    const localRelay = async () => {
      n++;
      if (n === 1) return { handled: false, upRes: null, lastErr: { ...EMPTY_ERR, message: "EMPTY_MODEL_RESPONSE: x retryAfterSeconds: 1" } };
      return { handled: true };
    };
    await runSerialTrial(baseCtx({ upstream, evt: (t, d) => events.push({ t, d }) }), { localRelay, exhaustedAll: async () => ({ done: true }) });
    const retry = events.find((e) => e.t === "empty-turn-retry");
    assert.equal(retry.d.delayMs, 1000, "撞限流时不再用 10ms 档，抬到上游给的窗口");
  });
});

test("空转重试耗尽：默认阶梯 3 次后交回（共 4 次上游）", async () => {
  await withEnv(LADDER, async () => {
    let chats = 0;
    const upstream = { chat: async () => { chats++; return { status: 200 }; } };
    const r = await runSerialTrial(baseCtx({ upstream }), { localRelay: alwaysErr, exhaustedAll: async () => ({ done: true }) });
    assert.equal(r.done, true, "耗尽后走 peers/groups（空）终结");
    assert.equal(chats, 4, "1+3=4 次上游");
  });
});

test("MSLXDFF_EMPTY_TURN_RETRIES=0：关闭重试回旧行为", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_RETRIES: "0", MSLXDFF_EMPTY_TURN_RETRY_STEPS: "[10]" }, async () => {
    let chats = 0;
    const upstream = { chat: async () => { chats++; return { status: 200 }; } };
    await runSerialTrial(baseCtx({ upstream }), { localRelay: alwaysErr, exhaustedAll: async () => ({ done: true }) });
    assert.equal(chats, 1, "关闭时只拉一次上游");
  });
});

test("非空转失败不重试：500 直走原有路径", async () => {
  await withEnv(LADDER, async () => {
    let chats = 0;
    const upstream = { chat: async () => { chats++; return { status: 200 }; } };
    const localRelay = async () => ({ handled: false, upRes: null, lastErr: { model: "m", status: 502, message: "stream timed out after 1ms" } });
    await runSerialTrial(baseCtx({ upstream }), { localRelay, exhaustedAll: async () => ({ done: true }) });
    assert.equal(chats, 1, "超时失败不触发空转重试");
  });
});

test("重试救回 → empty-turn-recovered 记第几次、累计白等多久", async () => {
  await withEnv(LADDER, async () => {
    const events = [];
    let relays = 0;
    const upstream = { chat: async () => ({ status: 200 }) };
    const localRelay = async () => { relays++; return relays <= 2 ? { handled: false, upRes: null, lastErr: { ...EMPTY_ERR } } : { handled: true, wrotePayload: true }; }; // 救回需送达证据（ADR-0043 R6）
    await runSerialTrial(baseCtx({ upstream, evt: (n, d) => events.push({ n, d }) }), { localRelay, exhaustedAll: async () => ({ done: true }) });
    const rec = events.find((e) => e.n === "empty-turn-recovered");
    assert.ok(rec, "救回来必须单独记一行");
    assert.equal(rec.d.retries, 2);
    assert.equal(rec.d.waitedMs, 30, "10+20 两档累计");
  });
});

test("重试用尽 → empty-turn-exhausted + errors.log 一行交代放弃原因", async () => {
  await withEnv(LADDER, async () => {
    const events = [];
    const errs = [];
    const upstream = { chat: async () => ({ status: 200 }) };
    await runSerialTrial(
      baseCtx({ upstream, evt: (n, d) => events.push({ n, d }), logError: (m, s, msg) => errs.push([m, s, msg]) }),
      { localRelay: alwaysErr, exhaustedAll: async () => ({ done: true }) },
    );
    const ex = events.find((e) => e.n === "empty-turn-exhausted");
    assert.ok(ex, "用尽要单独记一行");
    assert.equal(ex.d.retries, 3);
    assert.equal(ex.d.waitedMs, 60, "10+20+30 累计");
    assert.ok(errs.some((e) => /空转重试 3\/3 后仍无输出/.test(e[2])), "errors.log 必须有放弃说明");
  });
});

test("正文为空就重试：不设\"能否送达\"前提，最多 3 次（共 4 发）", async () => {
  await withEnv({ ...LADDER, MSLXDFF_EMPTY_TURN_RAISE_TOKENS: undefined }, async () => {
    const events = [];
    let chats = 0;
    const upstream = { chat: async () => { chats++; return { status: 200 }; } };
    await runSerialTrial(baseCtx({ upstream, evt: (n, d) => events.push({ n, d }) }), { localRelay: alwaysErr, exhaustedAll: async () => ({ done: true }) });
    assert.equal(chats, 4, "空正文一律重试：1+3 发");
    assert.equal(events.filter((e) => e.n === "empty-turn-retry").length, 3);
    assert.equal(events.some((e) => e.n === "empty-turn-unretryable"), false, "不再有\"不可重试\"分支");
  });
});

test("重试前抬 max_tokens：8192→16384，到顶后不重复抬", async () => {
  await withEnv({ ...LADDER, MSLXDFF_EMPTY_TURN_RAISE_TOKENS: "16384" }, async () => {
    const events = [];
    const seen = [];
    const upstream = { chat: async (p) => { seen.push(p); return { status: 200 }; } };
    const ctx = baseCtx({ upstream, evt: (n, d) => events.push({ n, d }) });
    ctx.body = { ...ctx.body, max_tokens: 8192 };
    await runSerialTrial(ctx, { localRelay: alwaysErr, exhaustedAll: async () => ({ done: true }) });
    assert.equal(seen[0].max_tokens, 8192, "首次按客户端原额");
    assert.equal(seen[1].max_tokens, 16384, "第 1 次重试抬到顶");
    assert.equal(seen[2].max_tokens, 16384, "封顶后不再抬（也绝不无限加）");
    const rs = events.filter((e) => e.n === "empty-turn-retry");
    assert.deepEqual([rs[0].d.raiseFrom, rs[0].d.raiseTo], [8192, 16384], "抬额必须留在日志里");
    assert.equal(rs[1].d.raiseTo, undefined, "第二次重试不重复抬额");
  });
});

test("抬额可关：MSLXDFF_EMPTY_TURN_RAISE_TOKENS=0 时同参重拉", async () => {
  await withEnv({ ...LADDER, MSLXDFF_EMPTY_TURN_RAISE_TOKENS: "0" }, async () => {
    const seen = [];
    const upstream = { chat: async (p) => { seen.push(p); return { status: 200 }; } };
    const ctx = baseCtx({ upstream });
    ctx.body = { ...ctx.body, max_completion_tokens: 4096 };
    await runSerialTrial(ctx, { localRelay: alwaysErr, exhaustedAll: async () => ({ done: true }) });
    assert.equal(seen[1].max_completion_tokens, 4096, "关闭时不抬 max_completion_tokens");
  });
});

test("withRaisedMaxTokens：翻倍封顶 / 不传 floor 不发明（兜底由调用方给）/ 到顶原样", () => {
  assert.equal(withRaisedMaxTokens({ max_tokens: 8192 }, 16384).max_tokens, 16384);
  assert.equal(withRaisedMaxTokens({ max_tokens: 30000 }, 16384).max_tokens, 30000, "超顶的原样返回");
  assert.equal(withRaisedMaxTokens({ max_completion_tokens: 100 }, 16384).max_completion_tokens, 200);
  const noKey = { model: "m" };
  assert.equal(withRaisedMaxTokens(noKey, 16384), noKey, "不传 floor 就不替客户端发明上限（现网兜底由 serial-trial 传 MIN_RAISE_TO，见 stream-empty-turn-hold.test.js）");
  assert.equal(withRaisedMaxTokens({ max_tokens: 8192 }, 0).max_tokens, 8192, "cap=0 关闭抬额");
});

test("RETRIES 超过档数：阶梯取模复用，step 永不出界（spec: step = 真用过的档位下标）", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_RETRY_STEPS: "[5]", MSLXDFF_EMPTY_TURN_RETRIES: "5", MSLXDFF_EMPTY_TURN_RETRY_DELAY_MS: undefined }, async () => {
    const events = [];
    let chats = 0;
    const upstream = { chat: async () => { chats++; return { status: 200 }; } };
    await runSerialTrial(baseCtx({ upstream, evt: (n, d) => events.push({ n, d }) }), { localRelay: alwaysErr, exhaustedAll: async () => ({ done: true }) });
    const rs = events.filter((e) => e.n === "empty-turn-retry");
    assert.equal(chats, 6, "1+5 发上游");
    assert.deepEqual(rs.map((e) => e.d.delayMs), [5, 5, 5, 5, 5], "单档复用 5 次");
    assert.deepEqual(rs.map((e) => e.d.step), [0, 0, 0, 0, 0], "step 若是重试序号会写出 step=4 而 delayMs 用的是 steps[0]，自相矛盾");
  });
});

test("逃生阀（legacy）模式也必带 step：否则 grep step= 假阴性", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_RETRY_STEPS: "[]", MSLXDFF_EMPTY_TURN_RETRY_DELAY_MS: "5", MSLXDFF_EMPTY_TURN_RETRIES: "1" }, async () => {
    const events = [];
    const upstream = { chat: async () => ({ status: 200 }) };
    await runSerialTrial(baseCtx({ upstream, evt: (n, d) => events.push({ n, d }) }), { localRelay: alwaysErr, exhaustedAll: async () => ({ done: true }) });
    const rs = events.filter((e) => e.n === "empty-turn-retry");
    assert.equal(rs.length, 1);
    assert.equal(rs[0].d.step, 0, "固定档即第 0 档");
    assert.equal(rs[0].d.delayMs, 5);
  });
});
