import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateUsage, readUsageRows, usageReport } from "../src/usage/report.js";
import { usageDir } from "../src/usage/record.js";

const HOUR = 3_600_000;
const NOW = new Date(2026, 8, 19, 12, 0, 0).getTime();

function row(model, tsOffsetHours, extra = {}) {
  return { ts: NOW + tsOffsetHours * HOUR, model, ...extra };
}

test("窗口过滤：窗口内计入、窗口外丢弃", () => {
  const rows = [
    row("a/x", -1, { completion_tokens: 10, total_tokens: 10 }),
    row("a/x", -23, { completion_tokens: 20, total_tokens: 20 }),
    row("a/x", -25, { completion_tokens: 999, total_tokens: 999 }),
    row("a/x", 1, { completion_tokens: 888, total_tokens: 888 }),
  ];
  const r = aggregateUsage(rows, { hours: 24, now: NOW });
  assert.equal(r.rows, 2);
  assert.equal(r.models.length, 1);
  assert.equal(r.models[0].requests, 2);
  assert.equal(r.models[0].completionTokens, 30);
  assert.equal(r.since, NOW - 24 * HOUR);
  assert.equal(r.until, NOW);
});

test("按 totalTokens 降序排序，多模型", () => {
  const rows = [
    row("m/small", -1, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    row("m/big", -1, { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }),
    row("m/mid", -1, { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }),
  ];
  const r = aggregateUsage(rows, { hours: 24, now: NOW });
  assert.deepEqual(r.models.map((m) => m.id), ["m/big", "m/mid", "m/small"]);
});

test("速度用加权口径（Σcompletion/ΣcompletionMs），不是算术平均", () => {
  const rows = [
    // tps = 50/1.0s = 50
    row("m/a", -1, { completion_tokens: 50, total_tokens: 50, ttfbMs: 0, totalMs: 1000 }),
    // tps = 50/0.1s = 500（算术平均会是 275）
    row("m/a", -1, { completion_tokens: 50, total_tokens: 50, ttfbMs: 0, totalMs: 100 }),
  ];
  const r = aggregateUsage(rows, { hours: 24, now: NOW });
  assert.equal(r.models[0].avgTps, 90.9);
});

test("总耗时含首字：生成耗时 = totalMs - ttfbMs", () => {
  const rows = [row("m/a", -1, { completion_tokens: 100, total_tokens: 100, ttfbMs: 900, totalMs: 1900 })];
  const r = aggregateUsage(rows, { hours: 24, now: NOW });
  // 生成耗时 1000ms → 100 tok/s
  assert.equal(r.models[0].avgTps, 100);
  assert.equal(r.models[0].avgTtfbMs, 900);
  assert.equal(r.models[0].avgTotalMs, 1900);
});

test("--model 过滤只留指定模型，但 totals 也只统计该模型", () => {
  const rows = [
    row("m/a", -1, { completion_tokens: 10, total_tokens: 10 }),
    row("m/b", -1, { completion_tokens: 90, total_tokens: 90 }),
  ];
  const r = aggregateUsage(rows, { hours: 24, now: NOW, model: "m/a" });
  assert.deepEqual(r.models.map((m) => m.id), ["m/a"]);
  assert.equal(r.totals.totalTokens, 10);
});

test("空数据：模型列表空、totals 全 0、速度与耗时是 null 不是 NaN", () => {
  const r = aggregateUsage([], { hours: 24, now: NOW });
  assert.deepEqual(r.models, []);
  assert.equal(r.rows, 0);
  assert.equal(r.totals.requests, 0);
  assert.equal(r.totals.totalTokens, 0);
  assert.equal(r.totals.avgTps, null);
  assert.equal(r.totals.avgTtfbMs, null);
  assert.equal(r.totals.avgTotalMs, null);
});

test("total_tokens 缺失时用 prompt+completion 兜底；脏行被忽略", () => {
  const rows = [
    row("m/a", -1, { prompt_tokens: 7, completion_tokens: 3 }),
    row("m/a", -1, {}),
    { ts: "not-a-number", model: "m/a" },
    null,
    row("", -1, { total_tokens: 5 }),
  ];
  const r = aggregateUsage(rows, { hours: 24, now: NOW });
  assert.equal(r.models.length, 1);
  assert.equal(r.models[0].requests, 2);
  assert.equal(r.models[0].totalTokens, 10);
});

test("reasoning_tokens 单独累计", () => {
  const rows = [
    row("m/a", -1, { completion_tokens: 10, total_tokens: 10, reasoning_tokens: 4 }),
    row("m/a", -1, { completion_tokens: 10, total_tokens: 10, reasoning_tokens: 6 }),
  ];
  const r = aggregateUsage(rows, { hours: 24, now: NOW });
  assert.equal(r.models[0].reasoningTokens, 10);
});

test("hours 非法时回退 24，窗口外的行随之被丢弃", () => {
  const r = aggregateUsage([row("m/a", -30, { total_tokens: 1 })], { hours: 0, now: NOW });
  assert.equal(r.windowHours, 24);
  assert.equal(r.models.length, 0, "30 小时前在 24h 窗口外");
  assert.equal(r.rows, 0);
});


test("--model 裸 id 匹配 canonical 全称行（--model big-pickle → opencode/big-pickle）", () => {
  const rows = [
    row("opencode/big-pickle", -1, { completion_tokens: 10, total_tokens: 10 }),
    row("workbuddy/hy3", -1, { completion_tokens: 99, total_tokens: 99 }),
  ];
  const r = aggregateUsage(rows, { hours: 24, now: NOW, model: "big-pickle" });
  assert.deepEqual(r.models.map((m) => m.id), ["opencode/big-pickle"]);
  assert.equal(r.totals.totalTokens, 10);
});

test("窗口边界：ts==since 与 ts==until 都计入", () => {
  const rows = [
    row("m/a", -24, { completion_tokens: 1, total_tokens: 1 }),
    row("m/a", 0, { completion_tokens: 1, total_tokens: 1 }),
  ];
  const r = aggregateUsage(rows, { hours: 24, now: NOW });
  assert.equal(r.rows, 2);
});

test("now 传 NaN 时回退当前时间（纯函数防御）", () => {
  const t = Date.now() - 60_000; // 真实过去 1 分钟，任何回退基准都在窗口内
  const r = aggregateUsage([{ ts: t, model: "m/a", total_tokens: 5 }], { hours: 24, now: NaN });
  assert.equal(r.models.length, 1);
  assert.ok(Math.abs(r.until - Date.now()) < 5000, "until 应接近真实当前时间");
});
test("readUsageRows 跨日文件只取窗口内的行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-test-usage-rep-"));
  try {
    const u = usageDir({ dir });
    mkdirSync(u, { recursive: true });
    const d1 = new Date(NOW - 25 * HOUR);
    const d2 = new Date(NOW - 1 * HOUR);
    const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    writeFileSync(join(u, `${ymd(d1)}.jsonl`), JSON.stringify({ ts: NOW - 25 * HOUR, model: "old", total_tokens: 999 }) + "\n");
    writeFileSync(join(u, `${ymd(d2)}.jsonl`), JSON.stringify({ ts: NOW - 1 * HOUR, model: "new", total_tokens: 5 }) + "\n{broken json\n");
    const rows = await readUsageRows({ dir, hours: 24, now: NOW });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].model, "new");
    const rep = await usageReport({ dir, hours: 24, now: NOW });
    assert.equal(rep.models[0].id, "new");
    assert.equal(rep.models[0].totalTokens, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readUsageRows 目录不存在时返回空数组", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-test-usage-none-"));
  try {
    const rows = await readUsageRows({ dir, hours: 24, now: NOW });
    assert.deepEqual(rows, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// —— 思考 tokens 四态（spec「思考 tokens 分「上报 / 估算 / 零 / 未知」四态」）——
function reasoningOf(extra) {
  const r = aggregateUsage([row("m/a", -1, { completion_tokens: 100, total_tokens: 100, ...extra })], { hours: 24, now: NOW });
  return r.models[0];
}

test("思考：上游明确上报且 >0 → 用上报值，来源 reported", () => {
  const m = reasoningOf({ reasoning_tokens: 6, reasoning_reported: 1, reasoning_chars: 400 });
  assert.equal(m.reasoningTokens, 6, "上报值优先，估算不得覆盖它");
  assert.equal(m.reasoningSource, "reported");
});

test("思考：未上报但流里有思考 → chars/4 估算，来源 estimated", () => {
  const m = reasoningOf({ reasoning_chars: 88, reasoning_reported: 0 });
  assert.equal(m.reasoningTokens, 22, "ceil(88/4)");
  assert.equal(m.reasoningSource, "estimated");
  assert.equal(m.reasoningChars, 88, "原值随 --json 给出，将来换计价口径不必回填");
});

test("思考：上游报 0 却确有思考内容（矛盾态）→ 以观测为准出估算", () => {
  const m = reasoningOf({ completion_tokens: 400, reasoning_tokens: 0, reasoning_reported: 1, reasoning_chars: 800 });
  assert.equal(m.reasoningTokens, 200, "矛盾时不得把真实思考压回 0");
  assert.equal(m.reasoningSource, "estimated");
});

test("思考：明确上报 0 且确无思考内容 → 精确 0（不是 —）", () => {
  const m = reasoningOf({ reasoning_tokens: 0, reasoning_reported: 1, reasoning_chars: 0 });
  assert.equal(m.reasoningTokens, 0);
  assert.equal(m.reasoningSource, "reported");
});

test("思考：既无上报也无内容 → 数值仍是 0（类型不破），来源 none 供表格渲染 —", () => {
  const m = reasoningOf({});
  assert.equal(m.reasoningTokens, 0);
  assert.equal(typeof m.reasoningTokens, "number", "--json 既有字段类型不得变 null");
  assert.equal(m.reasoningSource, "none");
});

test("思考：修复前只有 reasoning_tokens 的旧行仍按上报值显示（不丢现网 1755 行真数据）", () => {
  const m = reasoningOf({ reasoning_tokens: 2327 });
  assert.equal(m.reasoningTokens, 2327);
  assert.equal(m.reasoningSource, "reported");
});

test("思考：估算值收敛到 completion_tokens 以内（思考是输出的子集）", () => {
  const r = aggregateUsage([row("m/a", -1, { completion_tokens: 10, total_tokens: 10, reasoning_chars: 4000 })], { hours: 24, now: NOW });
  assert.equal(r.models[0].reasoningTokens, 10, "ceil(4000/4)=1000 荒谬 → 压到输出量");
});

test("思考：同模型混有上报行与估算行 → 合计来源 mixed，不冒充单一精确数", () => {
  const r = aggregateUsage([
    row("m/a", -1, { completion_tokens: 100, total_tokens: 100, reasoning_tokens: 6, reasoning_reported: 1 }),
    row("m/a", -1, { completion_tokens: 100, total_tokens: 100, reasoning_chars: 88, reasoning_reported: 0 }),
  ], { hours: 24, now: NOW });
  assert.equal(r.models[0].reasoningTokens, 28);
  assert.equal(r.models[0].reasoningSource, "mixed");
  assert.equal(r.totals.reasoningSource, "mixed");
});

// —— 首字样本覆盖度（spec「首字样本覆盖度必须可见」）——
test("覆盖度：非流式行不进分子也不进分母，旧行按未知计入分母", () => {
  const rows = [
    row("m/a", -1, { completion_tokens: 9, total_tokens: 9, ttfbMs: 100, totalMs: 1100, stream: 1 }),
    row("m/a", -1, { completion_tokens: 9, total_tokens: 9, ttfbMs: null, totalMs: 300, stream: 1 }),
    row("m/a", -1, { completion_tokens: 9, total_tokens: 9, ttfbMs: null, totalMs: 200, stream: 0 }),
    row("m/a", -1, { completion_tokens: 9, total_tokens: 9, ttfbMs: null, totalMs: 100 }),
  ];
  const m = aggregateUsage(rows, { hours: 24, now: NOW }).models[0];
  assert.equal(m.requests, 4, "请求数仍是全量");
  assert.equal(m.ttfSamples, 1, "只有 1 条真有首字");
  assert.equal(m.streamRequests, 3, "分母 = 流式(2) + 未知(1)，不含明确非流式(1)");
  assert.equal(m.avgTtfbMs, 100);
});

test("覆盖度：窗口内全是非流式行时分母为 0（表格据此显示 —，不拿空样本算均值）", () => {
  const rows = [
    row("m/a", -1, { completion_tokens: 1, total_tokens: 1, ttfbMs: null, totalMs: 50, stream: 0 }),
    row("m/a", -1, { completion_tokens: 1, total_tokens: 1, ttfbMs: null, totalMs: 60, stream: 0 }),
  ];
  const r = aggregateUsage(rows, { hours: 24, now: NOW });
  assert.equal(r.models[0].streamRequests, 0);
  assert.equal(r.models[0].ttfSamples, 0);
  assert.equal(r.models[0].avgTtfbMs, null);
  assert.equal(r.totals.streamRequests, 0);
});

test("覆盖度：0ms 首字算样本（旧代码把它当缺失，现网 ttfbMs=0 的行数为 0）", () => {
  const m = aggregateUsage([row("m/a", -1, { completion_tokens: 5, total_tokens: 5, ttfbMs: 0, totalMs: 500, stream: 1 })], { hours: 24, now: NOW }).models[0];
  assert.equal(m.ttfSamples, 1);
  assert.equal(m.avgTtfbMs, 0);
});

test("速度恒等：首字与总耗时同加常数偏移，avgTps 不变（本项修复不动速度排序）", () => {
  const base = [
    row("m/a", -1, { completion_tokens: 50, total_tokens: 50, ttfbMs: 200, totalMs: 1200, stream: 1 }),
    row("m/a", -1, { completion_tokens: 200, total_tokens: 200, ttfbMs: 50, totalMs: 4050, stream: 1 }),
  ];
  const shifted = base.map((r) => ({ ...r, ttfbMs: r.ttfbMs + 12_000, totalMs: r.totalMs + 12_000 }));
  const before = aggregateUsage(base, { hours: 24, now: NOW }).models[0];
  const after = aggregateUsage(shifted, { hours: 24, now: NOW }).models[0];
  assert.ok(Math.abs(before.avgTps - after.avgTps) <= 0.1, `重锚前后速度必须一致：${before.avgTps} vs ${after.avgTps}`);
  assert.ok(after.avgTtfbMs - before.avgTtfbMs >= 11_900, "首字列变诚实（这才是本次要修的）");
});

test("since 优先于 hours：当日 0 点窗口只聚合 0 点后的行（CLI 默认窗口的引擎表达）", () => {
  const midnight = new Date(2026, 8, 19, 0, 0, 0).getTime();
  const rows = [
    { ts: midnight - 1, model: "m/a", completion_tokens: 999, total_tokens: 999 },
    row("m/a", -23, { completion_tokens: 500, total_tokens: 500 }),
    { ts: midnight, model: "m/a", completion_tokens: 1, total_tokens: 1 },
    { ts: NOW, model: "m/a", completion_tokens: 2, total_tokens: 2 },
  ];
  const r = aggregateUsage(rows, { hours: 24, since: midnight, now: NOW });
  assert.equal(r.since, midnight);
  assert.equal(r.rows, 2, "0 点前的行 MUST NOT 计入");
  assert.equal(r.models[0].completionTokens, 3);
  assert.equal(r.windowHours, 12, "windowHours 如实反映 0 点→12 点的 12h");
});

test("readUsageRows/usageReport 带 since：跨日文件只取窗口起点后的行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-test-usage-since-"));
  try {
    const u = usageDir({ dir });
    mkdirSync(u, { recursive: true });
    const midnight = new Date(2026, 8, 19, 0, 0, 0).getTime();
    const ymd = (ts) => {
      const d = new Date(ts);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    writeFileSync(join(u, `${ymd(midnight - HOUR)}.jsonl`), JSON.stringify({ ts: midnight - HOUR, model: "old", total_tokens: 999 }) + "\n");
    writeFileSync(join(u, `${ymd(midnight + 60_000)}.jsonl`), JSON.stringify({ ts: midnight + 60_000, model: "fresh", total_tokens: 5 }) + "\n");
    const rows = await readUsageRows({ dir, since: midnight, now: NOW });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].model, "fresh");
    const rep = await usageReport({ dir, since: midnight, now: NOW });
    assert.equal(rep.models[0].id, "fresh");
    assert.equal(rep.since, midnight);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});