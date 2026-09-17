import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelayPipeline } from "../src/routes/chat/relay-pipeline.js";

// recordModelStats 会写 state：显式隔离到临时文件，别落到别的测试/真实 state
const DIR = mkdtempSync(join(tmpdir(), "mslxdff-relay-pipe-"));
process.env.MSLXDFF_STATE_FILE = join(DIR, "state.json");
process.on("exit", () => { try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

const BASE = {
  STREAM_TIMEOUT_MS: 25_000,
  SLOW_TOTAL_MS: 20_000,
  STALL_TIMEOUT_MS: 0,
  SCORE_STALL_MS: 15_000,
};

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

function fakeUpRes() {
  return { status: 200, headers: { get: () => null }, _t: null };
}

function makeHarness(outRelay) {
  const rec = { errors: [], latencies: [], oks: [], events: [], logErrors: [], calls: [] };
  const pipe = createRelayPipeline({
    relay: async () => outRelay,
    buildFallbackInfo: () => null,
    auto: {
      recordError: async (m, o) => rec.errors.push({ m, o }),
      recordLatency: async (m, ms) => rec.latencies.push({ m, ms }),
      recordOk: async (m, o) => rec.oks.push({ m, o }),
    },
    plugins: [],
    evt: (name, data) => rec.events.push({ name, data }),
    mark: () => {},
    logCall: (m, s) => rec.calls.push({ m, s }),
    logError: (m, s, msg) => rec.logErrors.push({ m, s, msg }),
    constants: BASE,
    startedAt: 1000,
    stages: [],
  });
  return { pipe, rec };
}

async function exec(pipe, handlerCtx) {
  return pipe.execute({
    res: fakeRes(),
    upRes: fakeUpRes(),
    body: { stream: true, model: "m" },
    requested: "m",
    actual: "m",
    lastErr: null,
    via: "local",
    lockModel: "",
    useAuto: true,
    handlerCtx,
    mark: () => {},
    perf0: 1000,
    stages: [],
    startedAt: Date.now(),
  });
}

const CTX = { reqId: "r1", hops: 0, model: "m", orderLen: 2, idx: 0 };

test("timedOut=true 触发 failover（status 数值不再参与判定）", async () => {
  const { pipe, rec } = makeHarness({ status: 504, timedOut: true, ttfMs: null, totalMs: 30, aborted: true, interrupted: false, detail: {} });
  const r = await exec(pipe, CTX);
  assert.equal(r.handled, false, "超时必须交回上层换候选");
  assert.equal(r.upRes, null);
  assert.equal(r.lastErr.status, 502);
  assert.match(r.lastErr.message, /stream timed out/);
  assert.equal(rec.errors.length, 1);
  assert.equal(rec.errors[0].o.slow, true);
  assert.equal(rec.logErrors.length, 1);
  assert.equal(rec.events.find((e) => e.name === "relay-done")?.data.timedOut, true);
});

test("status 恰等于闸门值但 timedOut 非 true：不再被误判为超时", async () => {
  const { pipe, rec } = makeHarness({ status: 25_000, timedOut: false, ttfMs: 5, totalMs: 50, aborted: false, interrupted: false, detail: { stallHits: 0 } });
  const r = await exec(pipe, CTX);
  assert.equal(r.handled, true, "数值巧合不再是超时信号");
  assert.equal(rec.errors.length, 0);
});

test("流正常（timedOut=false, status 200）：记账 ok", async () => {
  const { pipe, rec } = makeHarness({ status: 200, timedOut: false, ttfMs: 5, totalMs: 50, aborted: false, interrupted: false, detail: { stallHits: 0, usage: { completion_tokens: 4 }, chars: 10 } });
  const r = await exec(pipe, CTX);
  assert.equal(r.handled, true);
  assert.equal(rec.oks.length, 1);
  assert.equal(rec.errors.length, 0);
});
