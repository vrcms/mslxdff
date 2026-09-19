import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelayPipeline } from "../src/routes/chat/relay-pipeline.js";
import { usageDir, _resetPruneMarker } from "../src/usage/record.js";

// recordModelStats 写 state、recordUsage 写日志目录：都显式隔离到临时目录
const DIR = mkdtempSync(join(tmpdir(), "mslxdff-usage-pipe-"));
process.env.MSLXDFF_STATE_FILE = join(DIR, "state.json");
process.env.MSLXDFF_DAEMON_DIR = join(DIR, "logs");
process.on("exit", () => { try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

const BASE = {
  STREAM_TIMEOUT_MS: 25_000,
  SLOW_TOTAL_MS: 20_000,
  STALL_TIMEOUT_MS: 0,
  SCORE_STALL_MS: 15_000,
};

function fakeRes() {
  return { statusCode: 200, setHeader() {}, write() { return true; }, end() {}, on() { return this; }, removeListener() { return this; } };
}
function fakeUpRes() {
  return { status: 200, headers: { get: () => null }, _t: null };
}
function makeHarness(outRelay) {
  const pipe = createRelayPipeline({
    relay: async () => outRelay,
    buildFallbackInfo: () => null,
    auto: { recordError: async () => {}, recordLatency: async () => {}, recordOk: async () => {} },
    plugins: [],
    evt: () => {},
    mark: () => {},
    logCall: () => {},
    logError: () => {},
    constants: BASE,
    startedAt: 1000,
    stages: [],
  });
  return pipe;
}
async function exec(pipe, extra = {}) {
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
    handlerCtx: { reqId: "r1", hops: 0, model: "m", orderLen: 2, idx: 0 },
    mark: () => {},
    perf0: 1000,
    stages: [],
    startedAt: Date.now(),
    ...extra,
  });
}

test("relay 200 → usage JSONL 落行（含 prompt/total/加权输入），非 200 不落", async () => {
  _resetPruneMarker();
  const pipe = makeHarness({
    status: 200, ttfMs: 100, totalMs: 1100, interrupted: false, timedOut: false,
    detail: { usage: { prompt_tokens: 120, completion_tokens: 200, total_tokens: 320, reasoning_tokens: 40 }, chars: 0 },
  });
  await exec(pipe);
  await new Promise((r) => setTimeout(r, 50)); // 落盘是异步 append

  const u = usageDir();
  assert.ok(existsSync(u), "usage 目录应生成");
  const file = join(u, `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}.jsonl`);
  assert.ok(existsSync(file), "当日 JSONL 应生成");
  const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 1, "只按 canonical 名记一次");
  const row = rows[0];
  assert.equal(row.prompt_tokens, 120);
  assert.equal(row.completion_tokens, 200);
  assert.equal(row.total_tokens, 320);
  assert.equal(row.model, "opencode/m", "落盘用 canonical 全称");
  assert.equal(row.ttfbMs, 100);
  assert.equal(row.totalMs, 1100);
  assert.ok(row.ts > 0);

  // 非 200 不落
  const pipe2 = makeHarness({ status: 502, detail: { usage: { prompt_tokens: 9, completion_tokens: 9, total_tokens: 18 } }, interrupted: false, timedOut: false });
  await exec(pipe2);
  await new Promise((r) => setTimeout(r, 50));
  const rows2 = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows2.length, 1, "非 200 不应新增行");
});

test("recordChatUsage 行形状：缺失字段落 0/null 而不是 undefined", async () => {
  _resetPruneMarker();
  const { recordChatUsage } = await import("../src/usage/record.js");
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-usage-shape-"));
  try {
    const now = new Date(2026, 8, 19, 12, 0, 0);
    const row = await recordChatUsage({ model: "x/y", via: "peer", usage: null, ttfbMs: null, totalMs: 500, tps: NaN }, { dir, now });
    assert.equal(row.prompt_tokens, 0);
    assert.equal(row.completion_tokens, 0);
    assert.equal(row.total_tokens, 0);
    assert.equal(row.reasoning_tokens, 0);
    assert.equal(row.ttfbMs, null);
    assert.equal(row.totalMs, 500);
    assert.equal(row.tps, null);
    assert.equal(row.via, "peer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("interrupted 的 200 也落 usage，带 interrupted:1 标记", async () => {
  _resetPruneMarker();
  const pipe = makeHarness({
    status: 200, ttfMs: 200, totalMs: 5000, interrupted: true, timedOut: false,
    detail: { usage: { prompt_tokens: 500, completion_tokens: 300, total_tokens: 800 }, chars: 0 },
  });
  await exec(pipe);
  await new Promise((r) => setTimeout(r, 50));
  const file = join(usageDir(), `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}.jsonl`);
  const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const last = rows[rows.length - 1];
  assert.equal(last.interrupted, 1);

  assert.equal(last.completion_tokens, 300);
});