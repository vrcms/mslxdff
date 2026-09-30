import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelayPipeline } from "../src/routes/chat/relay-pipeline.js";
import { usageDir, _resetPruneMarker } from "../src/usage/record.js";
import { aggregateUsage } from "../src/usage/report.js";

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
    // reasoning_tokens=0 只说明「没有可报的值」；是否上报过由新增布尔位表达，二者不得混为一谈
    assert.equal(row.reasoning_reported, 0);
    assert.equal(row.reasoning_chars, 0);
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

// —— 量测锚点（OpenSpec fix-stats-report-accuracy / D2）——
test("pipeline 把本次上游尝试锚点交给 relay，首字才量得到上游等待", async () => {
  let gotAnchor = "未被传入";
  const pipe = createRelayPipeline({
    relay: async (_res, _upRes, _body, opts) => {
      gotAnchor = opts?.attemptStartMs;
      return { status: 200, ttfMs: 3, totalMs: 100, preflightMs: 0, interrupted: false, timedOut: false, detail: { usage: null } };
    },
    buildFallbackInfo: () => null,
    auto: { recordError: async () => {}, recordLatency: async () => {}, recordOk: async () => {} },
    plugins: [], evt: () => {}, mark: () => {}, logCall: () => {}, logError: () => {},
    constants: BASE, startedAt: 1000, stages: [],
  });
  await pipe.execute({
    res: fakeRes(), upRes: fakeUpRes(), body: { stream: true, model: "m" }, requested: "m", actual: "m",
    lastErr: null, via: "local", lockModel: "", useAuto: true,
    handlerCtx: { reqId: "r1", hops: 0, model: "m", orderLen: 1, idx: 0 },
    mark: () => {}, perf0: 1000, stages: [], startedAt: Date.now(), attemptStartMs: 4321.5,
  });
  assert.equal(gotAnchor, 4321.5, "relay 必须收到同一个锚点");
});

test("usage 行的首字/总耗时含锚点偏移：上游排队 5 秒不再凭空消失", async () => {
  _resetPruneMarker();
  const pipe = makeHarness({
    status: 200, ttfMs: 0, totalMs: 1000, preflightMs: 5000, interrupted: false, timedOut: false,
    detail: { usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 } },
  });
  await exec(pipe, { actual: "anchorrow", requested: "anchorrow" });
  await new Promise((r) => setTimeout(r, 50));
  const file = join(usageDir(), `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}.jsonl`);
  const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  // 落盘是 fire-and-forget，跨用例顺序不保证 → 按独立模型名取行，不靠「文件末行」
  const row = rows.filter((x) => x.model === "opencode/anchorrow").pop();
  assert.ok(row, "anchorrow 行应已落盘");
  assert.equal(row.ttfbMs, 5000, "首字 = 转发入口首帧 0ms + 上游等待 5000ms");
  assert.equal(row.totalMs, 6000, "总耗时同加一个偏移 → 生成耗时（总−首字）保持 1000ms");
});

test("recordModelStats 仍收旧的转入口径：本期不碰 -status/-model stats", async () => {
  _resetPruneMarker();
  // 用独立模型名：避开同文件前序用例在 state 里累积的 EMA（那是另一条数据源）
  const pipe = makeHarness({
    status: 200, ttfMs: 7, totalMs: 900, preflightMs: 5000, interrupted: false, timedOut: false,
    detail: { usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
  });
  await exec(pipe, { actual: "anchorprobe", requested: "anchorprobe" });
  await new Promise((r) => setTimeout(r, 50));
  const st = JSON.parse(readFileSync(join(DIR, "state.json"), "utf8"));
  const ms = st.modelStats?.["opencode/anchorprobe"];
  assert.ok(ms, "state 的 modelStats 应被写入");
  assert.equal(ms.avgTtfbMs, 7, "state 侧仍是转发入口相对口径（未被锚点偏移污染）");
});

test("首字 0ms 是有效样本：必须落盘为 0，不再被当缺失值丢弃", async () => {
  _resetPruneMarker();
  const pipe = makeHarness({
    status: 200, ttfMs: 0, totalMs: 800, preflightMs: 0, interrupted: false, timedOut: false,
    detail: { usage: { prompt_tokens: 5, completion_tokens: 20, total_tokens: 25 } },
  });
  await exec(pipe, { actual: "zerottf", requested: "zerottf" });
  await new Promise((r) => setTimeout(r, 50));
  const file = join(usageDir(), `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}.jsonl`);
  const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const row = rows.filter((x) => x.model === "opencode/zerottf").pop();
  assert.equal(row.ttfbMs, 0, "0ms 必须原样落盘（旧代码把它判成 null 丢掉了）");
  const agg = aggregateUsage([row], { hours: 24, now: row.ts });
  assert.equal(agg.models[0].avgTtfbMs, 0, "0 必须进入首字均值，而不是因「无样本」变 null");
});