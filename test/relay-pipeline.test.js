import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// 引入待实现深模块（红阶段应报 MODULE_NOT_FOUND，绿后通过）
import { createRelayPipeline } from "../src/routes/chat/relay-pipeline.js";
import { buildFallbackInfo } from "../src/routes/fallback.js";

// 桩
function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    wrote: [],
    ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = String(v); },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    write(c) { this.wrote.push(String(c)); },
    end(c) { if (c) this.wrote.push(String(c)); this.ended = true; },
    on() { return this; },
    removeListener() { return this; },
  };
  return res;
}
function spyAuto() {
  const calls = { ok: [], err: [], lat: [] };
  return {
    recordOk: async (m, o) => calls.ok.push([m, o]),
    recordError: async (m, o) => calls.err.push([m, o]),
    recordLatency: async (m, o) => calls.lat.push([m, o]),
    _calls: calls,
  };
}
function evtProbe() {
  const list = [];
  const evt = (type, data) => list.push({ type, data });
  return { evt, list, types: () => list.map((e) => e.type) };
}

const BASE = {
  STREAM_TIMEOUT_MS: 25_000,
  SLOW_TOTAL_MS: 20_000,
  STALL_TIMEOUT_MS: 0,
  SCORE_STALL_MS: 15_000,
};

function makePipeline({ relayImpl, auto, evtFn, plugins = [], mark = () => {}, logCall = () => {}, logError = () => {}, constants = BASE } = {}) {
  const { evt, list } = evtFn || evtProbe();
  const a = auto || spyAuto();
  const relay = relayImpl || (async () => ({ status: 200, ttfMs: 12, totalMs: 120, aborted: false, interrupted: false, detail: { stallHits: 0, maxGapMs: 10, exitReason: "normal" } }));
  const pipe = createRelayPipeline({
    relay,
    buildFallbackInfo,
    auto: a,
    plugins,
    evt,
    mark,
    logCall,
    logError,
    perfNow: () => 1000,
    stages: [],
    startedAt: 1000,
    constants,
  });
  return { pipe, auto: a, evtList: list, evtFn: evt };
}

describe("relay-pipeline 深模块", () => {
  test("US1 via=local 非流 200 正常 → recordOk 且无 slow", async () => {
    const auto = spyAuto();
    const { list } = evtProbe();
    let probe = evtProbe();
    const { pipe, auto: a } = makePipeline({
      relayImpl: async () => ({ status: 200, ttfMs: 12, totalMs: 120, aborted: false, interrupted: false, detail: { stallHits: 0, maxGapMs: 10, exitReason: "normal-non-stream" } }),
      auto,
      evtFn: probe,
      constants: BASE,
    });
    const res = fakeRes();
    const now = Date.now();
    const out = await pipe.execute({
      res,
      upRes: { status: 200, headers: { get: () => null }, _t: { totalMs: 50 } },
      body: { stream: false, model: "m", messages: [{ role: "user", content: "hi" }] },
      requested: "m",
      actual: "m",
      lastErr: null,
      via: "local",
      lockModel: "",
      useAuto: false,
      handlerCtx: { reqId: "r1", hops: 0, model: "m" },
      mark: () => {},
      perf0: 1000,
      stages: [],
      startedAt: now,
    });
    assert.equal(out.handled, true);
    assert.equal(a._calls.ok.length, 1, "should recordOk once");
    assert.equal(a._calls.err.length, 0);
    const types = probe.list.map((e) => e.type);
    assert.ok(types.includes("relay-start"), `missing relay-start in ${types}`);
    assert.ok(types.includes("relay-done"));
    assert.ok(types.includes("result"));
    assert.ok(types.includes("client-response"));
    assert.equal(types.includes("slow-model"), false, "should not be slow");
  });

  test("US2 peer stall>0 计慢 → recordError+Latency", async () => {
    const probe = evtProbe();
    const auto = spyAuto();
    const { pipe } = makePipeline({
      relayImpl: async () => ({ status: 200, ttfMs: 20, totalMs: 900, aborted: false, interrupted: false, detail: { stallHits: 2, maxGapMs: 16000, exitReason: "normal" } }),
      auto,
      evtFn: probe,
    });
    const res = fakeRes();
    await pipe.execute({
      res,
      upRes: { status: 200, headers: { get: () => null }, _t: { totalMs: 80 } },
      body: { stream: true, model: "x", messages: [] },
      requested: "req",
      actual: "peer-m",
      lastErr: null,
      via: "peer",
      lockModel: "",
      useAuto: false,
      handlerCtx: { reqId: "r2", hops: 0, model: "peer-m" },
      mark: () => {},
      perf0: 0,
      stages: [],
      startedAt: Date.now(),
    });
    assert.equal(auto._calls.err.length, 1);
    assert.equal(auto._calls.lat.length, 1);
    assert.ok(probe.list.some((e) => e.type === "slow-model" && e.data.reason === "stall"));
  });

  test("US4 流首块超时未写字节 → handled:false + timeout 计错", async () => {
    const probe = evtProbe();
    const auto = spyAuto();
    let logErrCalls = [];
    const { pipe } = makePipeline({
      relayImpl: async () => ({ status: BASE.STREAM_TIMEOUT_MS, ttfMs: null, totalMs: 25000, aborted: true, interrupted: false, detail: { exitReason: "first-timeout" } }),
      auto,
      evtFn: probe,
      logCall: () => {},
      logError: (...a) => logErrCalls.push(a),
    });
    const res = fakeRes();
    const out = await pipe.execute({
      res,
      upRes: { status: 200, headers: { get: () => null } },
      body: { stream: true },
      requested: "m",
      actual: "m",
      lastErr: null,
      via: "local",
      lockModel: "",
      useAuto: true,
      handlerCtx: { reqId: "r4", hops: 0, model: "m" },
      mark: () => {},
      perf0: 0,
      stages: [],
      startedAt: 0,
    });
    assert.equal(out.handled, false, "timeout 未写字节应回退给 gateway");
    assert.ok(out.lastErr && out.lastErr.status === 502);
    assert.equal(auto._calls.err.length, 1);
    assert.ok(probe.list.some((e) => e.type === "upstream-error" && e.data.message === "stream timeout"));
  });

  test("US5 interrupted=true 慢中断 → handled:true 且 recordError", async () => {
    const probe = evtProbe();
    const auto = spyAuto();
    const { pipe } = makePipeline({
      relayImpl: async () => ({ status: 200, ttfMs: 15, totalMs: 8000, aborted: false, interrupted: true, detail: { exitReason: "stall", stallHits: 1 } }),
      auto,
      evtFn: probe,
    });
    const res = fakeRes();
    const out = await pipe.execute({
      res,
      upRes: { status: 200, headers: { get: () => null } },
      body: { stream: true },
      requested: "m",
      actual: "m",
      lastErr: null,
      via: "local",
      lockModel: "",
      useAuto: true,
      handlerCtx: { reqId: "r5", hops: 0, model: "m" },
      mark: () => {},
      perf0: 0,
      stages: [],
      startedAt: 0,
    });
    assert.equal(out.handled, true);
    assert.equal(auto._calls.err.length, 1);
    assert.ok(probe.list.some((e) => e.type === "slow-model" && e.data.interrupted === true));
    assert.ok(probe.list.some((e) => e.type === "result" && e.data.interrupted === true));
  });

  test("US6 elapsed>SLOW_TOTAL 计总慢", async () => {
    const probe = evtProbe();
    const auto = spyAuto();
    const { pipe } = makePipeline({
      relayImpl: async () => ({ status: 200, ttfMs: 10, totalMs: 21000, aborted: false, interrupted: false, detail: { stallHits: 0, maxGapMs: 100, exitReason: "normal" } }),
      auto,
      evtFn: probe,
    });
    const res = fakeRes();
    // 通过 startedAt 远过去使 elapsed > 20000
    const startedAt = Date.now() - 21000;
    await pipe.execute({
      res,
      upRes: { status: 200, headers: { get: () => null } },
      body: { stream: true },
      requested: "m",
      actual: "m",
      lastErr: null,
      via: "local",
      lockModel: "",
      useAuto: true,
      handlerCtx: { reqId: "r6", hops: 0, model: "m" },
      mark: () => {},
      perf0: 0,
      stages: [],
      startedAt,
    });
    assert.equal(auto._calls.err.length, 1);
    assert.ok(probe.list.some((e) => e.type === "slow-model" && e.data.reason === "total"));
  });

  test("US7 非慢 200 正常记 Ok 唯一", async () => {
    const probe = evtProbe();
    const auto = spyAuto();
    const { pipe } = makePipeline({
      relayImpl: async () => ({ status: 200, ttfMs: 10, totalMs: 500, aborted: false, interrupted: false, detail: { stallHits: 0, maxGapMs: 80, exitReason: "normal" } }),
      auto,
      evtFn: probe,
    });
    const res = fakeRes();
    await pipe.execute({
      res,
      upRes: { status: 200, headers: { get: () => null } },
      body: { stream: false },
      requested: "m",
      actual: "m",
      lastErr: null,
      via: "local",
      lockModel: "",
      useAuto: true,
      handlerCtx: { reqId: "r7", hops: 0, model: "m" },
      mark: () => {},
      perf0: 0,
      stages: [],
      startedAt: Date.now(),
    });
    assert.equal(auto._calls.ok.length, 1);
    assert.equal(auto._calls.err.length, 0);
    assert.equal(probe.list.filter((e) => e.type === "slow-model").length, 0);
  });

  test("US8 fallback 通知 → fallback-notice 首发", async () => {
    const probe = evtProbe();
    const { pipe } = makePipeline({
      relayImpl: async () => ({ status: 200, ttfMs: 10, totalMs: 300, aborted: false, interrupted: false, detail: { stallHits: 0, maxGapMs: 50, exitReason: "normal" } }),
      evtFn: probe,
    });
    const res = fakeRes();
    await pipe.execute({
      res,
      upRes: { status: 200, headers: { get: () => null } },
      body: { stream: false },
      requested: "req-m",
      actual: "act-m",
      lastErr: { status: 429 },
      via: "local",
      lockModel: "",
      useAuto: false,
      handlerCtx: { reqId: "r8", hops: 0, model: "act-m" },
      mark: () => {},
      perf0: 0,
      stages: [],
      startedAt: Date.now(),
    });
    assert.equal(probe.list[0].type, "fallback-notice", `first evt should be fallback-notice, got ${probe.list[0]?.type}`);
    assert.equal(probe.list[0].data.fallback, true);
    assert.ok(probe.list.some((e) => e.type === "relay-start" && e.data.fallback?.fallback === true));
  });

  test("US10 插件钩子保序 relay:first-chunk + request:completed", async () => {
    let firstChunkSeen = false;
    let completedSeen = null;
    const plugins = [
      {
        name: "p1",
        hooks: {
          "relay:first-chunk": async (ctx) => { firstChunkSeen = true; assert.equal(ctx.via, "local"); },
          "request:completed": async (ctx) => { completedSeen = ctx; },
        },
      },
    ];
    // 适配 runHook 形状：测试中 createRelayPipeline 内部会调 runHook(plugins,...)
    // 需要把 plugins 转为 createRelayPipeline 可识别形状，pipeline 内部直接调 runHook
    const probe = evtProbe();
    const { pipe } = makePipeline({
      relayImpl: async (res, upRes, body, opts) => {
        // 模拟 relay 首次块回调
        opts.onFirstChunk?.(22);
        return { status: 200, ttfMs: 22, totalMs: 200, aborted: false, interrupted: false, detail: { stallHits: 0, exitReason: "normal" } };
      },
      evtFn: probe,
      plugins,
    });
    const res = fakeRes();
    await pipe.execute({
      res,
      upRes: { status: 200, headers: { get: () => null } },
      body: { stream: true },
      requested: "m",
      actual: "m",
      lastErr: null,
      via: "local",
      lockModel: "",
      useAuto: true,
      handlerCtx: { reqId: "r10", hops: 0, model: "m" },
      mark: () => {},
      perf0: 0,
      stages: [],
      startedAt: Date.now(),
    });
    // pipeline 应透传 first-chunk 事件
    assert.equal(probe.list.some((e) => e.type === "relay-first-chunk"), true);
  });

  test("broadband 双形态之一 via=broadband 仍走同一 pipeline", async () => {
    const probe = evtProbe();
    const auto = spyAuto();
    const { pipe } = makePipeline({
      relayImpl: async () => ({ status: 200, ttfMs: 11, totalMs: 400, aborted: false, interrupted: false, detail: { stallHits: 0, exitReason: "normal" } }),
      auto,
      evtFn: probe,
    });
    const res = fakeRes();
    for (const via of ["broadband", "broadband-local"]) {
      probe.list.length = 0;
      auto._calls.ok.length = 0;
      await pipe.execute({
        res: fakeRes(),
        upRes: { status: 200, headers: { get: () => null } },
        body: { stream: false },
        requested: "req",
        actual: "m",
        lastErr: null,
        via,
        lockModel: "",
        useAuto: false,
        handlerCtx: { reqId: "r-bb", hops: 0, model: "m" },
        mark: () => {},
        perf0: 0,
        stages: [],
        startedAt: Date.now(),
      });
      assert.ok(probe.list.some((e) => e.type === "relay-start" && e.data.via === via));
    }
  });
});
