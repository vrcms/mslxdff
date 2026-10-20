import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 红阶段：这两个模块尚不存在，应报 MODULE_NOT_FOUND
import { runAutoRace } from "../src/chat-pipeline/auto-race.js";
import { runSerialTrial } from "../src/chat-pipeline/serial-trial.js";

// state 隔离：auto 并发胜出会 savePreferredModel，指向 tmp
process.env.MSLXDFF_STATE_FILE = join(mkdtempSync(join(tmpdir(), "mslxdff-split-")), "state.json");

function okRes(ms) {
  const r = new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  r._t = { totalMs: ms };
  return r;
}
function errRes(status) {
  return new Response(JSON.stringify({ error: `upstream ${status}` }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function spyAuto(over = {}) {
  const calls = { ok: [], err: [], lat: [] };
  return {
    isCooling: () => false,
    statuses: () => ({}),
    recordOk: async (m, o) => calls.ok.push([m, o]),
    recordError: async (m, o) => calls.err.push([m, o]),
    recordLatency: async (m, o) => calls.lat.push([m, o]),
    _calls: calls,
    ...over,
  };
}
function baseCtx(over = {}) {
  return {
    reqId: "r-split",
    requested: "auto",
    body: { model: "auto", messages: [{ role: "user", content: "hi" }], stream: false },
    policy: { shareKeys: {}, workbuddyUid: null },
    shareKeys: {},
    workbuddyUid: null,
    useAuto: true,
    lockModel: "",
    hops: 0,
    canFallback: true,
    canForwardPeers: false,
    perf0: 0,
    stages: [],
    mark: () => {},
    evt: () => {},
    logCall: () => {},
    logError: () => {},
    handlerCtx: { reqId: "r-split", hops: 0, model: null },
    auto: spyAuto(),
    upstream: { chat: async () => okRes(10) },
    plugins: [],
    peers: null,
    groups: null,
    bus: null,
    token: "tok",
    logs: null,
    res: {},
    startedAt: Date.now(),
    order: [],
    ...over,
  };
}
function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    wrote: [],
    ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = String(v); },
    write(c) { this.wrote.push(String(c)); },
    end(c) { if (c) this.wrote.push(String(c)); this.ended = true; },
  };
}

describe("chat-pipeline engine 二次拆", () => {
  test("US1 auto-race 选最快胜出并走 local relay", async () => {
    const auto = spyAuto();
    let relayed = null;
    const deps = {
      localRelay: async ({ model }) => { relayed = model; return { handled: true }; },
      exhaustedAll: async () => { throw new Error("should not exhaust"); },
    };
    const ctx = baseCtx({
      order: ["slow-m", "fast-m"],
      auto,
      upstream: {
        chat: async (f) => (f.model === "fast-m" ? okRes(50) : okRes(300)),
      },
    });
    const out = await runAutoRace(ctx, deps);
    assert.equal(out.done, true);
    assert.equal(relayed, "fast-m");
    assert.ok(auto._calls.ok.some(([m]) => m === "fast-m"), "winner recorded ok");
  });

  test("US2 auto-race 全失败 → exhausted 且 order 耗尽", async () => {
    const auto = spyAuto();
    let exhausted = null;
    const deps = {
      localRelay: async () => { throw new Error("should not relay"); },
      exhaustedAll: async (a) => { exhausted = a; },
    };
    const ctx = baseCtx({
      order: ["a", "b"],
      auto,
      upstream: { chat: async () => errRes(500) },
    });
    const out = await runAutoRace(ctx, deps);
    assert.equal(out.done, true);
    assert.ok(exhausted, "exhaustedAll called");
    assert.equal(auto._calls.err.length, 2);
  });

  test("US3 serial-trial auto 下 allowlist-403 跳过，下一候选成功", async () => {
    let relayed = null;
    const errors = [];
    const deps = {
      localRelay: async ({ model }) => { relayed = model; return { handled: true }; },
      peerRelay: async () => ({ handled: false }),
      broadbandRelay: async () => ({ handled: false }),
      viaRoute: async () => ({ handled: false }),
      exhaustedLocal: async () => { throw new Error("should not exhaust"); },
      exhaustedAll: async () => { throw new Error("should not exhaust all"); },
      hedge: async () => ({ handled: false }),
    };
    const h = new Map([["x-mslxdff-allowlist", "1"]]);
    const ctx = baseCtx({
      order: ["blocked", "good"],
      useAuto: true,
      logError: (m, s, msg) => errors.push([m, s]),
      upstream: {
        chat: async (f) => {
          if (f.model === "blocked") {
            return { status: 403, headers: h, clone: () => ({ text: async () => "{}" }), text: async () => "{}" };
          }
          return okRes(20);
        },
      },
    });
    const out = await runSerialTrial(ctx, deps);
    assert.equal(out.done, true);
    assert.equal(relayed, "good");
    assert.ok(errors.some(([m, s]) => m === "blocked" && s === 403));
  });

  test("US4 serial-trial 显式模型 403 直接回 403", async () => {
    const res = fakeRes();
    const h = new Map([["x-mslxdff-allowlist", "1"]]);
    const deps = {
      localRelay: async () => { throw new Error("should not relay"); },
      peerRelay: async () => ({ handled: false }),
      broadbandRelay: async () => ({ handled: false }),
      viaRoute: async () => ({ handled: false }),
      exhaustedLocal: async () => { throw new Error("should not exhaust"); },
      exhaustedAll: async () => { throw new Error("should not exhaust all"); },
      hedge: async () => ({ handled: false }),
    };
    const ctx = baseCtx({
      order: ["blocked"],
      useAuto: false,
      res,
      upstream: {
        chat: async () => ({ status: 403, headers: h, clone: () => ({ text: async () => "{}" }), text: async () => "{}" }),
      },
    });
    await runSerialTrial(ctx, deps);
    assert.equal(res.statusCode, 403);
  });

  // 转发前上下文预检：本地失败后要把同一份大上下文转给组员时，必须先拦下让客户端压缩，
  // 而不是白烧对方额度再撞上游 `400 context_length_exceeded`。
  // 闸门设在**真正的出站口**（peers.forwardToPeer / via-route / broadband），所以这里用真 peerRelay 之外的
  // 真实路径难造；改为直接验证「peer 返回 contextGuard 时不再转给 broadband、立即收场」这条编排。
  test("US5 peer 被上下文闸门拦下 → 不再转 broadband，回 context_length_exceeded", async () => {
    const res = fakeRes();
    const events = [];
    let broadbandCalled = false;
    const guardErr = {
      model: "m1",
      upstream: null,
      status: 400,
      message: "context_length_exceeded: 请求约 250000 tokens，超过网关注入的转发上限 200000；请先运行 /compact 压缩上下文再重试。",
      contextGuard: { estimated: 250000, limit: 200000, over: 50000 },
    };
    const deps = {
      localRelay: async () => { throw new Error("should not relay"); },
      peerRelay: async () => { throw new Error("should not peer"); },
      // 真 peerRelay 会调 peers.js 的 forwardToPeer；这里直接在编排层模拟它带回 contextGuard
      broadbandRelay: async () => { broadbandCalled = true; return { handled: true }; },
      viaRoute: async () => ({ handled: false }),
      exhaustedLocal: async () => { throw new Error("should not exhaust"); },
      exhaustedAll: async () => { throw new Error("should not exhaust all"); },
      hedge: async () => ({ handled: false }),
    };
    const ctx = baseCtx({
      order: ["m1"],
      useAuto: false,
      res,
      canForwardPeers: true,
      groups: { list: () => ({}) },
      peers: { ordered: () => [], orderedByLastError: () => [], coolingByLastError: () => [] },
      evt: (t, d) => events.push({ t, d }),
      upstream: { chat: async () => errRes(429) },
    });
    // 让 peerRelay 直接交回被闸门拦下的结果（与 forwardToPeer 的真实产物同形）
    await runSerialTrial(ctx, { ...deps, peerRelay: async () => ({ handled: false, lastErr: guardErr }) });
    assert.equal(broadbandCalled, false, "被闸门拦下后不允许再试 broadband");
    assert.equal(res.statusCode, 400);
    assert.match(res.wrote.join(""), /context_length_exceeded/);
    assert.ok(events.some((e) => e.t === "context-guard"), "必须留 context-guard 事件");
  });
});
