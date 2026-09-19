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