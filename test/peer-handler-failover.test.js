import { test } from "node:test";
import assert from "node:assert/strict";
import { handlePeerRelay } from "../src/routes/chat/peer-handler.js";
import { handleHedge } from "../src/routes/chat/hedge-handler.js";
import { handleBroadbandRelay } from "../src/routes/chat/broadband-handler.js";
import { handleExhaustedLocal } from "../src/routes/chat/exhausted-handler.js";

// P0-3：peer/hedge 的薄适配丢弃 pipeline.execute 的 handled:false → 上层不再 failover、响应挂死。
// 用最小 deps 注入把 pipeline 与竞速替换为假实现，只锁"返回值传播"这一行为。

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    wrote: [],
    ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = String(v); },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    write(c) { this.wrote.push(Buffer.isBuffer(c) ? c.toString("utf8") : String(c)); return true; },
    end(c) { this.ended = true; if (c != null) this.wrote.push(String(c)); },
    on() { return this; },
    removeListener() { return this; },
  };
}

const TIMEOUT_OUT = { handled: false, upRes: null, lastErr: { model: "m", upstream: null, status: 502, message: "stream timed out after 120000ms" } };

function fakePipeline() {
  return { execute: async () => TIMEOUT_OUT };
}

function peerStub() {
  const peer = { url: "http://127.0.0.1:9", token: "t", name: "" };
  return {
    peer,
    peers: {
      ordered: () => [peer],
      orderedByLastError: () => [],
      coolingByLastError: () => [],
      recordResult: async () => {},
      recordError: async () => {},
      stat: () => null,
      isHot: () => false,
    },
  };
}

test("peer-handler：pipeline handled:false 必须交回上层（旧行为丢弃 → 挂死）", async () => {
  const { peer, peers } = peerStub();
  const r = await handlePeerRelay({
    model: "m",
    body: { stream: true, model: "m" },
    lastErr: null,
    requested: "m",
    useAuto: false,
    lockModel: null,
    auto: null,
    peers,
    handlerCtx: { reqId: "t-peer", hops: 0, orderLen: 1, idx: 0 },
    evt: () => {},
    logCall: () => {},
    logError: () => {},
    mark: () => {},
    perf0: Date.now(),
    stages: [],
    startedAt: Date.now(),
    plugins: [],
    res: fakeRes(),
    deps: {
      racePeerCandidates: async () => ({ peer, target: "m", res: { status: 200, headers: new Headers(), _t: null }, latencyMs: 5 }),
      createPipeline: fakePipeline,
    },
  });
  assert.equal(r.handled, false, "failover 信号必须传播");
  assert.match(String(r.lastErr?.message), /stream timed out/);
});

test("hedge-handler：peer winner 的 pipeline handled:false 同样传播", async () => {
  const { peers } = peerStub();
  const r = await handleHedge({
    upRes: { status: 200, headers: new Headers(), _t: null },
    model: "m",
    body: { stream: true, model: "m" },
    order: ["m"],
    idx: 0,
    lastErr: null,
    requested: "m",
    useAuto: false,
    lockModel: null,
    auto: null,
    peers,
    handlerCtx: { reqId: "t-hedge", hops: 0, orderLen: 1, idx: 0 },
    evt: () => {},
    logCall: () => {},
    logError: () => {},
    mark: () => {},
    perf0: Date.now(),
    stages: [],
    startedAt: Date.now(),
    plugins: [],
    res: fakeRes(),
    hedgeDelayMs: 1,
    deps: {
      hedgedFirstChunkRace: async () => ({
        winner: "peer",
        peerInfo: { peer: { url: "http://127.0.0.1:9" }, target: "m", res: { status: 200, headers: new Headers(), _t: null }, latencyMs: 3 },
        bufferedBody: (async function* () { yield Buffer.from("data: {}\n\n"); })(),
        ttfMs: 3,
      }),
      createPipeline: fakePipeline,
    },
  });
  assert.equal(r.handled, false, "failover 信号必须传播");
  assert.match(String(r.lastErr?.message), /stream timed out/);
});

test("hedge-handler：local winner 的 pipeline handled:false 同样传播", async () => {
  const { peers } = peerStub();
  const r = await handleHedge({
    upRes: { status: 200, headers: new Headers(), _t: null },
    model: "m",
    body: { stream: true, model: "m" },
    order: ["m"],
    idx: 0,
    lastErr: null,
    requested: "m",
    useAuto: false,
    lockModel: null,
    auto: null,
    peers,
    handlerCtx: { reqId: "t-hedge-local", hops: 0, orderLen: 1, idx: 0 },
    evt: () => {},
    logCall: () => {},
    logError: () => {},
    mark: () => {},
    perf0: Date.now(),
    stages: [],
    startedAt: Date.now(),
    plugins: [],
    res: fakeRes(),
    hedgeDelayMs: 1,
    deps: {
      hedgedFirstChunkRace: async () => ({
        winner: "local",
        upRes: { status: 200, headers: new Headers(), _t: null },
        bufferedBody: (async function* () { yield Buffer.from("data: {}\n\n"); })(),
        peerInfo: null,
        ttfMs: 2,
      }),
      createPipeline: fakePipeline,
    },
  });
  assert.equal(r.handled, false, "failover 信号必须传播");
  assert.match(String(r.lastErr?.message), /stream timed out/);
});

test("broadband-handler：leader 转发的 pipeline handled:false 必须交回上层", async () => {
  const r = await handleBroadbandRelay({
    model: "m",
    body: { stream: true, model: "m" },
    hops: 0,
    lastErr: null,
    requested: "m",
    useAuto: false,
    lockModel: null,
    auto: null,
    groups: null,
    token: null,
    bus: null,
    logs: null,
    handlerCtx: { reqId: "t-bb", hops: 0, orderLen: 1, idx: 0 },
    evt: () => {},
    mark: () => {},
    perf0: Date.now(),
    stages: [],
    res: fakeRes(),
    startedAt: Date.now(),
    plugins: [],
    deps: {
      tryBroadbandRelay: async () => ({ result: { status: 200, headers: new Headers(), _t: null } }),
      createPipeline: fakePipeline,
    },
  });
  assert.equal(r.handled, false, "failover 信号必须传播（丢弃 → 响应永不 end）");
  assert.match(String(r.lastErr?.message), /stream timed out/);
});

test("exhausted：relay 超时必须自己收尾（最后一站没有上层 failover）", async () => {
  const res = fakeRes();
  const r = await handleExhaustedLocal({
    res,
    body: { stream: true, model: "m" },
    lastErr: { model: "m", upstream: { status: 200, headers: new Headers(), _t: null }, status: 502, message: "peer failed" },
    order: ["m"],
    handlerCtx: { reqId: "t-exh", hops: 0, model: "m" },
    evt: () => {},
    logCall: () => {},
    mark: () => {},
    perf0: Date.now(),
    stages: [],
    done: () => {},
    requested: "m",
    useAuto: false,
    deps: {
      relay: async () => ({ status: 504, timedOut: true, ttfMs: null, totalMs: 120, aborted: true, interrupted: false, detail: { upstreamError: "terminated" } }),
    },
  });
  assert.equal(r, true);
  assert.equal(res.ended, true, "必须给对方一个终态响应，否则挂死");
  assert.match(String(res.wrote.join("")), /upstream error: terminated/);
});
