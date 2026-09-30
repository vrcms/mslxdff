import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { relay } from "../src/routes/stream.js";

// 验收硬门（OpenSpec fix-stats-report-accuracy / D2）：
// 上报时长必须从「本次上游尝试起点」量起，而保护闸门仍从 relay 入口量起——
// 两者一旦混用，要么首字永远读成 0/1ms，要么慢模型被闸门误杀。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    wrote: [],
    ended: false,
    _handlers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = String(v); },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    write(c) { this.wrote.push(Buffer.isBuffer(c) ? c.toString("utf8") : String(c)); return true; },
    end(c) { this.ended = true; if (c != null) this.wrote.push(String(c)); },
    on(k, fn) { (this._handlers[k] ??= []).push(fn); return this; },
    removeListener(k, fn) { const a = this._handlers[k]; if (a) this._handlers[k] = a.filter((f) => f !== fn); return this; },
    emit(k, ...args) { for (const f of [...(this._handlers[k] || [])]) f(...args); },
  };
  return res;
}

function sseChunk(obj) {
  return Buffer.from(`data: ${JSON.stringify(obj)}\n\n`, "utf8");
}

function upResWith(body, contentType = "text/event-stream") {
  return { status: 200, headers: new Headers({ "content-type": contentType }), body };
}

test("relay 带出锚点偏移：上游尝试起点到转发入口的等待不再被丢弃", async () => {
  const res = fakeRes();
  const body = {
    async *[Symbol.asyncIterator]() {
      yield sseChunk({ choices: [{ delta: { content: "好" } }] });
      yield Buffer.from("data: [DONE]\n\n");
    },
  };
  // qoder 形状：响应到手前上游已等 5 秒（provider 还预读了首帧），relay 一进来就有数据
  const attemptStartMs = performance.now() - 5_000;
  const r = await relay(res, upResWith(body), { stream: true }, { attemptStartMs });
  assert.equal(r.status, 200);
  assert.ok(r.preflightMs >= 5_000 && r.preflightMs < 5_300, `锚点偏移应≈5000ms，实得 ${r.preflightMs}`);
});

test("非流式返回点同样带锚点偏移：总耗时口径不变，偏移是新增字段", async () => {
  const res = fakeRes();
  const upRes = {
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    async text() { return JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }); },
  };
  const attemptStartMs = performance.now() - 4_000;
  const r = await relay(res, upRes, { stream: false }, { attemptStartMs });
  assert.equal(r.status, 200);
  assert.ok(r.preflightMs >= 4_000 && r.preflightMs < 4_300, `非流式也应带偏移，实得 ${r.preflightMs}`);
  assert.equal(r.ttfMs, r.totalMs, "非流式的 ttf 语义仍是 total（一次性返回）");
});

test("首帧超时返回点带偏移：totalMs 仍从转发入口量起，闸门没被预读等待吃掉", async () => {
  const res = fakeRes();
  let cancelled = false;
  const body = {
    async *[Symbol.asyncIterator]() {
      await sleep(150);
      if (!cancelled) yield sseChunk({ choices: [{ delta: { content: "不该出现" } }] });
    },
    cancel() { cancelled = true; },
  };
  const attemptStartMs = performance.now() - 3_000;
  const r = await relay(res, upResWith(body), { stream: true }, { streamTimeoutMs: 50, attemptStartMs });
  assert.equal(r.timedOut, true, "闸门仍按 50ms 预算触发");
  assert.ok(r.preflightMs >= 3_000 && r.preflightMs < 3_300, `偏移照常带出，实得 ${r.preflightMs}`);
  assert.ok(r.totalMs < 1_000, `totalMs 仍是转发入口相对值（实得 ${r.totalMs}ms），闸门口径未被锚点污染`);
});

// 验收硬门（spec「上游排队 20 秒、首帧超时预算 25 秒」）：等待发生在锚点里，
// 闸门零点不动 → 20s 排队 + 25s 预算的流必须正常收流，绝不能因锚点前移被误杀
test("排队 20s（记在锚点上）+ 首帧预算 25s：流正常收流，首字报 20s 量级", async () => {
  const res = fakeRes();
  const body = {
    async *[Symbol.asyncIterator]() {
      await sleep(120); // 上游真吐首帧的时刻（闸门看到的是这 120ms，不是 20s）
      yield sseChunk({ choices: [{ delta: { content: "排队后出字" } }] });
      yield Buffer.from("data: [DONE]\n\n");
    },
  };
  const attemptStartMs = performance.now() - 20_000;
  const r = await relay(res, upResWith(body), { stream: true }, { streamTimeoutMs: 25_000, attemptStartMs });
  assert.equal(r.timedOut, false, "20s 排队绝不能吃掉 25s 闸门预算");
  assert.equal(r.interrupted, false);
  assert.ok(r.detail.wroteChunks >= 1, "数据必须被写出");
  assert.ok(r.preflightMs >= 20_000 && r.preflightMs < 20_400, `首字口径应≈20s，实得 ${r.preflightMs}`);
  assert.ok(r.totalMs < 5_000, `totalMs 保持转发入口相对（实得 ${r.totalMs}ms）`);
});

// —— 尝试锚点的接线（task 2.3）：锚点必须来自「本次」上游尝试，跨候选不互相摊派 ——
test("串行尝试把本次上游尝试起点交给 relay handler，且每个候选各一个", async () => {
  const { runSerialTrial } = await import("../src/chat-pipeline/serial-trial.js");
  const anchors = [];
  const chatAt = [];
  let calls = 0;
  const upstream = {
    chat: async () => {
      chatAt.push(performance.now());
      calls++;
      if (calls === 1) await sleep(120); // 第一个候选慢慢失败
      return { status: 200, headers: new Headers({ "content-type": "application/json" }), async text() { return "{}"; } };
    },
  };
  const localRelay = async (a) => {
    anchors.push(a.attemptStartMs);
    return calls === 1
      ? { handled: false, upRes: null, lastErr: { model: "a", status: 502, message: "boom" } }
      : { handled: true };
  };
  const ctx = {
    order: ["a", "b"], reqId: "r1", requested: "a",
    body: { stream: false, model: "a", messages: [{ role: "user", content: "hi" }] },
    hops: 0, useAuto: false, lockModel: "", plugins: [], auto: null, upstream,
    peers: null, groups: null, bus: null, token: "t", canFallback: false, canForwardPeers: false,
    perf0: performance.now(), stages: [], mark: () => {}, evt: () => {}, logCall: () => {}, logError: () => {},
    done: null, handlerCtx: {}, res: {}, startedAt: Date.now(), logs: null, shareKeys: {},
  };
  const r = await runSerialTrial(ctx, { localRelay, exhaustedAll: async () => ({ done: true }) });
  assert.equal(r.done, true);
  assert.equal(anchors.length, 2, "两个候选各跑一次 relay");
  assert.ok(anchors.every((v) => Number.isFinite(v)), `锚点必须是有限数值，实得 ${JSON.stringify(anchors)}`);
  assert.ok(anchors[0] <= chatAt[0] && anchors[1] <= chatAt[1], "锚点必须先于本次 upstream 调用（否则量不到排队）");
  assert.ok(anchors[1] - anchors[0] >= 100, `第二个候选的锚点应晚于第一次尝试（实差 ${(anchors[1] - anchors[0]).toFixed(1)}ms）`);
});

test("peer 路径把锚点带进 relay 流水线（组员侧等待算得出来）", async () => {
  const { handlePeerRelay } = await import("../src/routes/chat/peer-handler.js");
  let seen = null;
  const peers = {
    ordered: () => [{ url: "http://127.0.0.1:8990" }],
    orderedByLastError: () => [],
    coolingByLastError: () => [],
    recordResult: async () => {},
  };
  const upRes = { status: 200, headers: { get: () => null } };
  const r = await handlePeerRelay({
    model: "m", body: { stream: true }, lastErr: null, requested: "m", useAuto: false, lockModel: "",
    auto: null, peers, handlerCtx: { reqId: "r1" }, evt: () => {}, logCall: () => {}, mark: () => {},
    perf0: 1000, attemptStartMs: 5555.5, stages: [], startedAt: Date.now(), plugins: [], res: {},
    deps: {
      racePeerCandidates: async () => ({ peer: { url: "http://127.0.0.1:8990" }, target: "m", res: upRes, latencyMs: 12 }),
      createPipeline: () => ({ execute: async (c) => { seen = c; return { handled: true }; } }),
    },
  });
  assert.equal(r.handled, true);
  assert.ok(seen, "pipeline.execute 应被调用");
  assert.equal(seen.attemptStartMs, 5555.5, "锚点必须一路带到 pipeline，再由它交给 relay");
});
