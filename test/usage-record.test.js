import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordUsage, pruneUsage, usageDir, usageFileFor, ymd, usageEnabled, usageKeepDays, recordChatUsage, _resetPruneMarker } from "../src/usage/record.js";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "mslxdff-test-usage-"));
}

test("recordUsage 按日落到 YYYY-MM-DD.jsonl 并追加", async () => {
  const dir = tmpDir();
  try {
    _resetPruneMarker();
    const now = new Date(2026, 8, 19, 10, 0, 0); // 2026-09-19 本地时间
    const r1 = await recordUsage({ model: "opencode/big-pickle", prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, { dir, now });
    const r2 = await recordUsage({ model: "opencode/big-pickle", prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }, { dir, now });
    assert.equal(r1.ts, now.getTime());
    assert.equal(r2.model, "opencode/big-pickle");
    const file = usageFileFor(now, { dir });
    assert.ok(existsSync(file), "应生成当日文件");
    assert.ok(file.endsWith(`${ymd(now)}.jsonl`));
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]).completion_tokens, 5);
    assert.deepEqual(JSON.parse(lines[1]).total_tokens, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordUsage 目录不存在时自动创建", async () => {
  const dir = join(tmpDir(), "nested", "deep");
  try {
    _resetPruneMarker();
    const now = new Date(2026, 8, 19);
    await recordUsage({ model: "m" }, { dir, now });
    assert.ok(existsSync(usageDir({ dir })));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MSLXDFF_USAGE_LOG=0 时完全不写", async () => {
  const dir = tmpDir();
  const prev = process.env.MSLXDFF_USAGE_LOG;
  try {
    process.env.MSLXDFF_USAGE_LOG = "0";
    assert.equal(usageEnabled(), false);
    _resetPruneMarker();
    const r = await recordUsage({ model: "m" }, { dir, now: new Date(2026, 8, 19) });
    assert.equal(r, null);
    assert.equal(existsSync(usageDir({ dir })), false);
  } finally {
    if (prev === undefined) delete process.env.MSLXDFF_USAGE_LOG; else process.env.MSLXDFF_USAGE_LOG = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneUsage 删早于保留期的日文件、保留窗口内的", async () => {
  const dir = tmpDir();
  try {
    const u = usageDir({ dir });
    mkdirSync(u, { recursive: true });
    for (const day of ["2026-09-14", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19"]) {
      writeFileSync(join(u, `${day}.jsonl`), "{}\n");
    }
    writeFileSync(join(u, "notes.txt"), "别删我\n");
    const now = new Date(2026, 8, 19, 12, 0, 0);
    const removed = await pruneUsage({ dir, keepDays: 2, now });
    assert.deepEqual(removed.sort(), ["2026-09-14.jsonl", "2026-09-16.jsonl"]);
    const left = readdirSync(u).sort();
    assert.deepEqual(left, ["2026-09-17.jsonl", "2026-09-18.jsonl", "2026-09-19.jsonl", "notes.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneUsage 目录不存在时静默返回空", async () => {
  const dir = tmpDir();
  try {
    const removed = await pruneUsage({ dir, now: new Date(2026, 8, 19) });
    assert.deepEqual(removed, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("usageKeepDays 默认 2、可被 env 覆盖", () => {
  const prev = process.env.MSLXDFF_USAGE_KEEP_DAYS;
  try {
    delete process.env.MSLXDFF_USAGE_KEEP_DAYS;
    assert.equal(usageKeepDays(), 2);
    process.env.MSLXDFF_USAGE_KEEP_DAYS = "7";
    assert.equal(usageKeepDays(), 7);
    process.env.MSLXDFF_USAGE_KEEP_DAYS = "0";
    assert.equal(usageKeepDays(), 2, "非法值回退默认");
  } finally {
    if (prev === undefined) delete process.env.MSLXDFF_USAGE_KEEP_DAYS; else process.env.MSLXDFF_USAGE_KEEP_DAYS = prev;
  }
});

// 报表要能区分「上游报了 0」「上游压根没报」「模型真没思考」——只靠 reasoning_tokens 一个字段做不到，
// 因此行内纯增原始观测（思考字符数 + 是否上报 + 是否流式），估算留给聚合层。
test("recordChatUsage 纯增 reasoning_chars / reasoning_reported / stream，既有字段不动", async () => {
  const dir = tmpDir();
  try {
    _resetPruneMarker();
    const now = new Date(2026, 8, 19, 12, 0, 0);
    const a = await recordChatUsage({
      model: "qoder/qfmodel", via: "local", stream: true, reasoningChars: 40,
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, reasoning_tokens: 6 },
      ttfbMs: 100, totalMs: 900, tps: 25,
    }, { dir, now });
    assert.equal(a.reasoning_chars, 40);
    assert.equal(a.reasoning_reported, 1);
    assert.equal(a.stream, 1);
    assert.equal(a.reasoning_tokens, 6, "既有 reasoning_tokens 语义不变");
    assert.equal(a.ttfbMs, 100);

    // qoder 的真实形状：usage 只有 prompt/completion，但流里有思考
    const b = await recordChatUsage({
      model: "qoder/qfmodel", via: "local", stream: false, reasoningChars: 88,
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      ttfbMs: null, totalMs: 300, tps: null,
    }, { dir, now });
    assert.equal(b.reasoning_reported, 0, "上游没报 reasoning_tokens → 未上报");
    assert.equal(b.reasoning_chars, 88);
    assert.equal(b.stream, 0);
    assert.equal(b.reasoning_tokens, 0, "缺上报时既有字段仍写 0（旧消费方不断裂）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("调用方没传 stream 时不落该字段（未知 ≠ 非流式）", async () => {
  const dir = tmpDir();
  try {
    _resetPruneMarker();
    const row = await recordChatUsage({ model: "m/x", via: "local", usage: null, ttfbMs: null, totalMs: 5, tps: null }, { dir, now: new Date(2026, 8, 19) });
    assert.equal("stream" in row, false, "臆断成 0 会让覆盖度分母悄悄变小");
    assert.equal(row.reasoning_chars, 0);
    assert.equal(row.reasoning_reported, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});