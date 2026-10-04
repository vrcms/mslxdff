import { test } from "node:test";
import assert from "node:assert/strict";
import { relay } from "../src/routes/stream.js";
import { endHeldFailure, holdEndEnabled } from "../src/routes/stream-hold.js";
import { json } from "../src/routes/helpers.js";
import { isEmptyTurnDetail } from "../src/routes/stream-scan.js";
import { runSerialTrial } from "../src/chat-pipeline/serial-trial.js";
import { emptyTurnBudgetMs, emptyTurnMinRaiseTo, withRaisedMaxTokens } from "../src/chat-pipeline/empty-turn.js";

// ---------- fake 上游/下游 ----------

function sseRes(chunks) {
  const enc = new TextEncoder();
  return {
    status: 200,
    headers: { get: () => "text/event-stream" },
    body: new ReadableStream({
      start(c) { for (const t of chunks) c.enqueue(enc.encode(t)); c.close(); },
    }),
  };
}

function nonStreamRes(jsonText) {
  return {
    status: 200,
    headers: { get: () => "application/json" },
    text: async () => jsonText,
  };
}

// 最小假 res：只实现 relay/json 真正会碰的面；write/end 记录字节供断言。
// strict=true 时像真 http.ServerResponse 一样：headers 已 flush 后再设 statusCode/setHeader 抛 ERR_HTTP_HEADERS_SENT
// （审查正是靠这条抓到「留口后重拉会炸在半路」）
function fakeRes({ alreadyFlushed = false, strict = false } = {}) {
  const writes = [];
  let statusCode = 0;
  const boom = () => { const e = new Error("ERR_HTTP_HEADERS_SENT"); e.code = "ERR_HTTP_HEADERS_SENT"; throw e; };
  const dec = (chunk) => (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : String(chunk));
  const r = {
    get statusCode() { return statusCode; },
    set statusCode(v) { if (strict && r.headersSent) boom(); statusCode = v; },
    headersSent: alreadyFlushed,
    writableEnded: false,
    destroyed: false,
    writes,
    setHeader() { if (strict && r.headersSent) boom(); },
    getHeader(k) { return String(k).toLowerCase() === "content-type" && r.headersSent ? "text/event-stream" : undefined; },
    write(chunk) {
      if (r.writableEnded) { const e = new Error("write after end"); e.code = "ERR_STREAM_WRITE_AFTER_END"; throw e; }
      writes.push(dec(chunk));
      r.headersSent = true;
      return true;
    },
    end(chunk) {
      if (r.writableEnded) { const e = new Error("already finished"); e.code = "ERR_STREAM_ALREADY_FINISHED"; throw e; }
      if (chunk != null) { writes.push(dec(chunk)); r.headersSent = true; }
      r.writableEnded = true;
      r.headersSent = true;
    },
    on(_ev, fn) { r._close = fn; return r; },
    removeListener() {},
  };
  return r;
}

// 空轮 = 上游只给空 delta 帧 + [DONE]，无任何正文/工具/思考（这类帧全被暂扣，一字节都不出）
const EMPTY_SSE = [
  'data: {"choices":[{"delta":{},"finish_reason":null}]}\n\n',
  "data: [DONE]\n\n",
];
// 思考型空轮（现网主流）：大量 reasoning 帧已发出、正文为零、额度被吃满
const REASONING_SSE = [
  'data: {"choices":[{"delta":{"reasoning_content":"我在想..."},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
  "data: [DONE]\n\n",
];
const TEXT_SSE = [
  'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  "data: [DONE]\n\n",
];
const EMPTY_JSON_BODY = JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "stop" }] });
const TEXT_JSON_BODY = JSON.stringify({ choices: [{ message: { content: "你好" }, finish_reason: "stop" }] });

async function withEnv(env, fn) {
  const prev = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(env)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
}

// ---------- R1/R2：relay 延后封口 ----------

test("relay：空轮流式正常结束 → 不 res.end()，heldOpen:true（R1 核心）", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_HOLD_END: undefined }, async () => {
    const res = fakeRes();
    const out = await relay(res, sseRes(EMPTY_SSE), { stream: true }, { keepaliveMs: 0 });
    assert.equal(out.heldOpen, true, "零产出 + 下游活着 + hold 开 → 必须留口");
    assert.equal(res.writableEnded, false, "绝不能在这一刻封口：封了客户端就拿到空答案");
    assert.equal(res.writes.join(""), "", "暂扣的前缀一字节都不该出去（这样重拉才能续写）");
    assert.equal(out.detail.exitReason, "empty-turn-hold");
  });
});

test("relay：HOLD_END=0 逃生阀 → 前缀补写出去 + 立即 end（旧行为逐字节复现）", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_HOLD_END: "0" }, async () => {
    const res = fakeRes();
    const out = await relay(res, sseRes(EMPTY_SSE), { stream: true }, { keepaliveMs: 0 });
    assert.ok(!out.heldOpen);
    assert.equal(res.writableEnded, true, "逃生阀 = 回到改前行为");
    assert.match(res.writes.join(""), /\[DONE\]/, "改前这些帧是直接透传的，必须原样补写");
  });
});

test("relay：思考型空轮（已发出 reasoning）→ 流尾补明确错误帧，不再莫名空白", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_HOLD_END: undefined }, async () => {
    const res = fakeRes();
    const out = await relay(res, sseRes(REASONING_SSE), { stream: true }, { keepaliveMs: 0 });
    assert.ok(!out.heldOpen, "思考已发出去撤不回，留口无意义");
    assert.equal(out.terminalForm, "sse-error-tail");
    assert.equal(out.detail.exitReason, "reasoning-only");
    const body = res.writes.join("");
    assert.match(body, /reasoning_content/, "思考帧照常透传（不缓冲思考）");
    assert.match(body, /data: \{"error":\{.*EMPTY_MODEL_RESPONSE/);
    assert.match(body, /data: \[DONE\]/);
  });
});

test("relay：已写出真实载荷再转空 → 照常收尾，不 hold（R2）", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_HOLD_END: undefined }, async () => {
    const res = fakeRes();
    const out = await relay(res, sseRes(TEXT_SSE), { stream: true }, { keepaliveMs: 0 });
    assert.equal(res.writableEnded, true);
    assert.ok(!out.heldOpen, "写出去的正文撤不回来，也不许换人重写");
    assert.equal(out.detail.wrotePayload, true);
  });
});

test("relay：非 chat 形状的透传（如裸 SSE）不判空轮、照常收尾", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_HOLD_END: undefined }, async () => {
    const res = fakeRes();
    const out = await relay(res, sseRes(["event: ping\n\n"]), { stream: true }, { keepaliveMs: 0 });
    assert.equal(res.writableEnded, true, "透传契约不受空轮判定影响（chatShaped=false 放行）");
    assert.ok(!out.heldOpen);
  });
});

test("relay：非流式空轮 → 不写 body，heldOpen:true（R1 非流式）", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_HOLD_END: undefined }, async () => {
    const res = fakeRes();
    const out = await relay(res, nonStreamRes(EMPTY_JSON_BODY), { stream: false }, {});
    assert.equal(out.heldOpen, true);
    assert.equal(res.writableEnded, false, "非流式此刻 headers 还没 flush，写 body 就晚了");
    assert.equal(res.writes.length, 0);
  });
});

test("relay：非流式有正文 → 照常 200 JSON（含 enrich）", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_HOLD_END: undefined }, async () => {
    const res = fakeRes();
    const out = await relay(res, nonStreamRes(TEXT_JSON_BODY), { stream: false }, {});
    assert.equal(res.writableEnded, true);
    assert.ok(!out.heldOpen);
    assert.equal(res.statusCode, 200);
    assert.match(res.writes.join(""), /你好/);
  });
});

// ---------- 终局收场（R4） ----------

test("endHeldFailure：headers 未 flush → 502 JSON，恰好一次收场", () => {
  const res = fakeRes();
  assert.equal(endHeldFailure(res, "EMPTY_MODEL_RESPONSE: 上游 3 次空轮"), true);
  assert.equal(res.statusCode, 502);
  assert.equal(res.writableEnded, true);
  assert.match(res.writes.join(""), /EMPTY_MODEL_RESPONSE/);
  assert.ok(!res.writes.join("").includes("data:"), "没 flush 过就必须是纯 JSON，不得混 SSE 帧");
});

test("endHeldFailure：headers 已 flush（keepalive 出去过了）→ SSE 错误帧 + [DONE]，不抛", () => {
  const res = fakeRes({ alreadyFlushed: true });
  assert.doesNotThrow(() => endHeldFailure(res, "EMPTY_MODEL_RESPONSE: 上游 3 次空轮"), "json 的 statusCode= 在已 flush 响应上会抛 ERR_HTTP_HEADERS_SENT，这正是要堵的");
  assert.equal(res.writableEnded, true);
  const body = res.writes.join("");
  assert.match(body, /data: \{"error":\{.*EMPTY_MODEL_RESPONSE/);
  assert.match(body, /data: \[DONE\]/);
});

test("endHeldFailure：已收场的响应必须 no-op（幂等守卫）", () => {
  const res = fakeRes();
  assert.equal(endHeldFailure(res, "x"), true);
  assert.equal(endHeldFailure(res, "y"), false, "二次收场是 bug，必须被守卫挡下");
});

test("json()：headers 已 flush / 已 end 时不再抛（幂等守卫）", () => {
  const flushed = fakeRes({ alreadyFlushed: true });
  assert.doesNotThrow(() => json(flushed, 502, { error: "x" }));
  const ended = fakeRes();
  ended.end();
  assert.doesNotThrow(() => json(ended, 502, { error: "x" }), "已 writableEnded 的响应必须 no-op");
});

// ---------- 判据（纯函数，单一真相） ----------

test("isEmptyTurnDetail：chat 形状 + 零正文 + 零工具 + 非 tool 收尾 才算空轮", () => {
  assert.equal(isEmptyTurnDetail({ chatShaped: true, chars: 0, toolCalls: 0, sawFinishReason: "stop" }), true);
  assert.equal(isEmptyTurnDetail({ chatShaped: false, chars: 0, toolCalls: 0 }), false, "非 chat 形状 = 透传契约，放行");
  assert.equal(isEmptyTurnDetail({ chatShaped: true, chars: 12, toolCalls: 0 }), false);
  assert.equal(isEmptyTurnDetail({ chatShaped: true, chars: 0, toolCalls: 1 }), false, "工具轮豁免");
  assert.equal(isEmptyTurnDetail({ chatShaped: true, chars: 0, toolCalls: 0, sawFinishReason: "tool_calls" }), false);
});

// ---------- 管线接线 ----------

test("relay-pipeline：heldOpen 空轮 → 交回重试且 lastErr 带 heldOpen/emptyTurn 标记", async () => {
  const { createRelayPipeline } = await import("../src/routes/chat/relay-pipeline.js");
  const events = [];
  const p = createRelayPipeline({
    relay: async () => ({ status: 200, heldOpen: true, detail: { chatShaped: true, chars: 0, toolCalls: 0, sawFinishReason: "stop", downstreamClosed: false } }),
    buildFallbackInfo: () => null,
    evt: (n, d) => events.push({ n, d }),
  });
  const r = await p.execute({
    res: fakeRes(), upRes: {}, body: { stream: true }, requested: "m", actual: "m",
    via: "local", lockModel: "", useAuto: false, handlerCtx: { reqId: "r1" }, mark: () => {},
  });
  assert.equal(r.handled, false);
  assert.equal(r.lastErr.status, 502);
  assert.match(r.lastErr.message, /^EMPTY_MODEL_RESPONSE/);
  assert.equal(r.lastErr.emptyTurn, true);
  assert.equal(r.lastErr.heldOpen, true, "serial-trial 要靠它知道响应还活着");
});

test("exhausted-handler：空轮 lastErr（无 upstream）→ 走 endHeldFailure；已 flush 的 SSE 拿到错误帧", async () => {
  const { handleExhaustedLocal } = await import("../src/routes/chat/exhausted-handler.js");
  const res = fakeRes({ alreadyFlushed: true });
  await handleExhaustedLocal({
    res, body: { stream: true }, lastErr: { model: "m", upstream: null, status: 502, emptyTurn: true, heldOpen: true, message: "EMPTY_MODEL_RESPONSE: x" },
    order: ["m"], handlerCtx: { reqId: "r1", model: "m" }, evt: () => {}, logCall: () => {}, mark: () => {}, perf0: 0, stages: [], done: () => {}, requested: "m", useAuto: false,
  });
  const body = res.writes.join("");
  assert.match(body, /data: \{"error":\{.*EMPTY_MODEL_RESPONSE/);
  assert.match(body, /data: \[DONE\]/);
  assert.equal(res.writableEnded, true);
});

// ---------- serial-trial：预算 + recovered 证据 ----------

function trialCtx(over = {}) {
  return {
    order: over.order || ["a", "b", "c"], reqId: "r1", requested: "m",
    body: { stream: true, model: "m", messages: [{ role: "user", content: "hi" }] },
    hops: 0, useAuto: false, lockModel: "", plugins: [],
    auto: null, upstream: over.upstream, peers: null, groups: null, bus: null, token: "t",
    canFallback: true, canForwardPeers: false,
    perf0: 0, stages: [], mark: () => {}, evt: over.evt || (() => {}),
    logCall: () => {}, logError: over.logError || (() => {}), done: null, handlerCtx: {},
    res: over.res || fakeRes(), startedAt: Date.now(), logs: null, shareKeys: {},
  };
}

test("serial-trial：跨候选等待受请求级预算封顶（R8）", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_RETRY_STEPS: "[10]", MSLXDFF_EMPTY_TURN_RETRIES: "5", MSLXDFF_EMPTY_TURN_BUDGET_MS: "25", MSLXDFF_EMPTY_TURN_MIN_RAISE_TO: "0", MSLXDFF_EMPTY_TURN_MAX_WAIT_MS: undefined }, async () => {
    const events = [];
    const errs = [];
    let chats = 0;
    const upstream = { chat: async () => { chats++; return { status: 200 }; } };
    const localRelay = async () => ({ handled: false, upRes: null, lastErr: { model: "m", upstream: null, status: 502, emptyTurn: true, heldOpen: true, message: "EMPTY_MODEL_RESPONSE: x" } });
    const r = await runSerialTrial(trialCtx({ upstream, evt: (n, d) => events.push({ n, d }), logError: (m, s, msg) => errs.push(msg) }), { localRelay, exhaustedAll: async () => ({ done: true }) });
    assert.equal(r.done, true);
    const waited = events.filter((e) => e.n === "empty-turn-retry").reduce((a, e) => a + e.d.delayMs, 0);
    assert.ok(waited <= 25 + 10, `累计等待必须停在预算内（实测 ${waited}ms）`);
    assert.ok(chats <= 6, `预算用尽后不许再开新发（实测 ${chats} 次上游）`);
    const ex = events.find((e) => e.n === "empty-turn-exhausted");
    assert.ok(ex, "预算用尽必须记 exhausted");
    assert.ok(errs.some((e) => /预算/.test(e)), `放弃原因必须写明预算（实测 ${JSON.stringify(errs)}）`);
  });
});

test("serial-trial：recovered 必须有送达证据，handled:true 而无载荷不发（R6）", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_RETRY_STEPS: "[10]", MSLXDFF_EMPTY_TURN_RETRIES: "1", MSLXDFF_EMPTY_TURN_MIN_RAISE_TO: "0" }, async () => {
    const events = [];
    let n = 0;
    const upstream = { chat: async () => ({ status: 200 }) };
    // 第一发空轮（handled:false），第二次 handled:true 但 wrotePayload=false（如下游断开后的假成功）
    const localRelay = async () => { n++; return n === 1 ? { handled: false, upRes: null, lastErr: { model: "m", upstream: null, status: 502, emptyTurn: true, heldOpen: true, message: "EMPTY_MODEL_RESPONSE: x" } } : { handled: true, wrotePayload: false }; };
    await runSerialTrial(trialCtx({ upstream, evt: (nm, d) => events.push({ nm, d }) }), { localRelay, exhaustedAll: async () => ({ done: true }) });
    assert.equal(events.some((e) => e.nm === "empty-turn-recovered"), false, "没有送达证据就不许记\"救回\"");

    const events2 = [];
    let k = 0;
    const localRelay2 = async () => { k++; return k === 1 ? { handled: false, upRes: null, lastErr: { model: "m", upstream: null, status: 502, emptyTurn: true, heldOpen: true, message: "EMPTY_MODEL_RESPONSE: x" } } : { handled: true, wrotePayload: true }; };
    await runSerialTrial(trialCtx({ upstream, evt: (nm, d) => events2.push({ nm, d }) }), { localRelay: localRelay2, exhaustedAll: async () => ({ done: true }) });
    const rec = events2.find((e) => e.nm === "empty-turn-recovered");
    assert.ok(rec, "真救回必须单独记一行");
    assert.equal(rec.d.retries, 1);
  });
});

// ---------- 兜底抬额度（思考型空轮的主因） ----------

test("withRaisedMaxTokens：客户端设过额度 → 翻倍抬顶；没设 → 兜底 MIN_RAISE_TO（=0 关）", () => {
  assert.equal(withRaisedMaxTokens({ max_tokens: 8192 }, 16384).max_tokens, 16384);
  assert.equal(withRaisedMaxTokens({ max_tokens: 30000 }, 16384).max_tokens, 30000, "超顶原样");
  const noKey = { model: "m" };
  assert.equal(withRaisedMaxTokens(noKey, 16384, 16384).max_tokens, 16384, "①的口径：客户端没设额度也兜底发明一次，否则「思考吃满」必然原样复现");
  assert.equal(withRaisedMaxTokens(noKey, 16384, 0), noKey, "floor=0 关兜底（回旧口径「不替它发明上限」）");
  assert.equal(withRaisedMaxTokens(noKey, 16384), noKey, "不传 floor 就不发明：兜底值由调用方（serial-trial）按 env 决定");
  assert.equal(withRaisedMaxTokens({ max_tokens: 8192 }, 16384, 4096).max_tokens, 16384, "设过额度的走翻倍，不吃 floor");
  assert.equal(withRaisedMaxTokens({ max_completion_tokens: 100 }, 16384).max_completion_tokens, 200);
});

test("emptyTurnMinRaiseTo：默认 16384，可覆盖，0=关", () => {
  return withEnv({ MSLXDFF_EMPTY_TURN_MIN_RAISE_TO: undefined }, () => assert.equal(emptyTurnMinRaiseTo(), 16384))
    .then(() => withEnv({ MSLXDFF_EMPTY_TURN_MIN_RAISE_TO: "32000" }, () => assert.equal(emptyTurnMinRaiseTo(), 32000)))
    .then(() => withEnv({ MSLXDFF_EMPTY_TURN_MIN_RAISE_TO: "0" }, () => assert.equal(emptyTurnMinRaiseTo(), 0)));
});

test("emptyTurnBudgetMs：默认 45s，可覆盖", () => {
  return withEnv({ MSLXDFF_EMPTY_TURN_BUDGET_MS: undefined }, () => assert.equal(emptyTurnBudgetMs(), 45000))
    .then(() => withEnv({ MSLXDFF_EMPTY_TURN_BUDGET_MS: "90000" }, () => assert.equal(emptyTurnBudgetMs(), 90000)));
});

test("holdEndEnabled：默认开，0/off/false 关", () => {
  return withEnv({ MSLXDFF_EMPTY_TURN_HOLD_END: undefined }, () => assert.equal(holdEndEnabled(), true))
    .then(() => withEnv({ MSLXDFF_EMPTY_TURN_HOLD_END: "0" }, () => assert.equal(holdEndEnabled(), false)))
    .then(() => withEnv({ MSLXDFF_EMPTY_TURN_HOLD_END: "off" }, () => assert.equal(holdEndEnabled(), false)));
});

test("serial-trial：客户端没设 max_tokens 时，重试载荷带上兜底额度（现网主因的对症修复）", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_RETRY_STEPS: "[10]", MSLXDFF_EMPTY_TURN_RETRIES: "1", MSLXDFF_EMPTY_TURN_MIN_RAISE_TO: "16384", MSLXDFF_EMPTY_TURN_RAISE_TOKENS: "16384" }, async () => {
    const seen = [];
    let n = 0;
    const upstream = { chat: async (p) => { seen.push(p); return { status: 200 }; } };
    const localRelay = async () => { n++; return n === 1 ? { handled: false, upRes: null, lastErr: { model: "m", upstream: null, status: 502, emptyTurn: true, heldOpen: true, message: "EMPTY_MODEL_RESPONSE: x" } } : { handled: true, wrotePayload: true }; };
    const ctx = trialCtx({ upstream });
    ctx.body = { stream: true, model: "m", messages: [{ role: "user", content: "hi" }] }; // 故意不设 max_tokens
    await runSerialTrial(ctx, { localRelay, exhaustedAll: async () => ({ done: true }) });
    assert.equal(seen[0].max_tokens, undefined, "首发按客户端原样（没设就是没设）");
    assert.equal(seen[1].max_tokens, 16384, "重拉兜底抬额度，不再同参复现");
  });
});

test("端到端：空轮留口 → 重拉的正文真的到了同一条连接（本次修复存在的意义）", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_HOLD_END: undefined }, async () => {
    const res = fakeRes();
    const first = await relay(res, sseRes(EMPTY_SSE), { stream: true }, { keepaliveMs: 0 });
    assert.equal(first.heldOpen, true, "第一发空轮：留口");
    assert.equal(res.writableEnded, false, "绝不能封口，否则第二发的正文无处可去");
    const second = await relay(res, sseRes(TEXT_SSE), { stream: true }, { keepaliveMs: 0 });
    assert.ok(!second.heldOpen, "第二发有正文：提交并收尾");
    const body = res.writes.join("");
    assert.match(body, /你好/, "正文真的送到了客户端（同一条连接，无需客户端重发请求）");
    assert.equal((body.match(/\[DONE\]/g) || []).length, 1, "第一发的 [DONE] 必须被撤销，不能留下两个终止符把流提前判完");
    assert.equal(res.writableEnded, true, "恰好一次收场");
  });
});

// ---------- 审查（ADR-0043 复审）补的回归：这几条各自抓过一个真 bug ----------

test("重入同一条连接（headers 已 flush）不得抛 ERR_HTTP_HEADERS_SENT，且正文照样送达【A1】", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_HOLD_END: undefined }, async () => {
    // strict res：setHeader/statusCode 在已 flush 后抛错，模拟真实 http.ServerResponse
    const res = fakeRes({ alreadyFlushed: true, strict: true });
    res.writes.push(": keepalive\n\n"); // 前一发的留口期间真的发过心跳，headers 就此锁死
    let out;
    assert.doesNotThrow(async () => { out = await relay(res, sseRes(TEXT_SSE), { stream: true }, { keepaliveMs: 0 }); }, "留口后重拉若在此抛错，主目的（续写正文）当场失效");
    out = await relay(res, sseRes(TEXT_SSE), { stream: true }, { keepaliveMs: 0 });
    assert.ok(!out.heldOpen);
    assert.match(res.writes.join(""), /你好/, "正文必须能写进这条已 flush 的连接");
  });
});

test("思考-only：错误帧排在 [DONE] **之前**，且终止符只出现一次【A4】", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_HOLD_END: undefined }, async () => {
    const res = fakeRes();
    const out = await relay(res, sseRes(REASONING_SSE), { stream: true }, { keepaliveMs: 0 });
    const body = res.writes.join("");
    assert.equal((body.match(/\[DONE\]/g) || []).length, 1, "两个终止符 = 客户端可能在第一个就收尾，错误帧白写");
    assert.ok(body.indexOf('"error"') < body.indexOf("[DONE]"), "错误帧必须在终止符之前");
    assert.equal(out.terminalForm, "sse-error-tail");
  });
});

test("未知形状帧（choices[].text / 无 choices）绝不被当可撤销前缀扣下【A6 透传红线】", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_HOLD_END: undefined }, async () => {
    const res = fakeRes();
    const out = await relay(res, sseRes(['data: {"choices":[{"text":"裸文本输出"}]}\n\n', "data: [DONE]\n\n"]), { stream: true }, { keepaliveMs: 0 });
    assert.ok(!out.heldOpen, "看不懂的形状一律透传，不能因为 chars 统计为 0 就整段撤销");
    assert.match(res.writes.join(""), /裸文本输出/);
  });
});

test("下游已断开：不留口、不再补写暂扣帧、记账不骗人【R6/R3】", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_HOLD_END: undefined }, async () => {
    const res = fakeRes();
    res.destroyed = true; // 客户端在这一发结束前就走了
    const out = await relay(res, sseRes(EMPTY_SSE), { stream: true }, { keepaliveMs: 0 });
    assert.ok(!out.heldOpen, "写给消失的读者没有意义：不留口，serial-trial 也不会再开新发");
    assert.equal(out.detail.downstreamClosed, true);
    assert.equal(res.writes.join(""), "", "暂扣的前缀必须丢弃，不是补写到死连接上");
    assert.equal(out.detail.wroteChunks, 0, "wroteChunks 虚增会骗排障的人");
  });
});

test("逃生阀 HOLD_END=0：下游字节与改前完全一致（顺序+内容逐字节）【R7】", async () => {
  await withEnv({ MSLXDFF_EMPTY_TURN_HOLD_END: "0" }, async () => {
    const res = fakeRes();
    await relay(res, sseRes(EMPTY_SSE), { stream: true }, { keepaliveMs: 0 });
    assert.equal(res.writes.join(""), EMPTY_SSE.join(""), "逐字节复现：不重排、不吞帧、不多写终止符");
    assert.equal(res.writableEnded, true);
  });
});
