import { test } from "node:test";
import assert from "node:assert/strict";
import { createRelayPipeline } from "../src/routes/chat/relay-pipeline.js";

const BASE = {
  STREAM_TIMEOUT_MS: 25_000,
  SLOW_TOTAL_MS: 20_000,
  STALL_TIMEOUT_MS: 0,
  SCORE_STALL_MS: 15_000,
};

function makePipeline(capture) {
  return createRelayPipeline({
    relay: async (res, upRes, body, opts) => {
      capture.push(opts.streamTimeoutMs);
      return { status: 200, ttfMs: 5, totalMs: 50, aborted: false, interrupted: false, detail: { stallHits: 0, maxGapMs: 5, exitReason: "normal" } };
    },
    buildFallbackInfo: () => null,
    auto: null,
    plugins: [],
    evt: () => {},
    mark: () => {},
    logCall: () => {},
    logError: () => {},
    constants: BASE,
    startedAt: 1000,
    stages: [],
  });
}

function fakeRes() {
  return {
    statusCode: 200,
    setHeader() {},
    write() { return true; },
    end() {},
    on() { return this; },
    removeListener() { return this; },
  };
}

async function exec(pipe, handlerCtx) {
  return pipe.execute({
    res: fakeRes(),
    upRes: { status: 200, headers: { get: () => null }, _t: null },
    body: { stream: true, model: "m" },
    requested: "m",
    actual: "m",
    lastErr: null,
    via: "local",
    lockModel: "",
    useAuto: false,
    handlerCtx,
    mark: () => {},
    perf0: 1000,
    stages: [],
    startedAt: Date.now(),
  });
}

test("唯一候选：首块闸门放宽到防泄漏级别（不再被 25s 误杀）", async () => {
  const cap = [];
  await exec(makePipeline(cap), { reqId: "r1", hops: 0, model: "m", orderLen: 1 });
  assert.equal(cap[0], 120_000);
});

test("多候选中非最后：保持 25s 快速 failover 语义", async () => {
  const cap = [];
  await exec(makePipeline(cap), { reqId: "r2", hops: 0, model: "m", orderLen: 3, idx: 0 });
  assert.equal(cap[0], 25_000);
});

test("多候选中已是最后一个：同样放宽（无 failover 去向）", async () => {
  const cap = [];
  await exec(makePipeline(cap), { reqId: "r3", hops: 0, model: "m", orderLen: 3, idx: 2 });
  assert.equal(cap[0], 120_000);
});

test("候选信息未知：回退默认 25s（行为不变）", async () => {
  const cap = [];
  await exec(makePipeline(cap), { reqId: "r4", hops: 0, model: "m" });
  assert.equal(cap[0], 25_000);
});
