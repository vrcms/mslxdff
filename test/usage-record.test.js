import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordUsage, pruneUsage, usageDir, usageFileFor, ymd, usageEnabled, usageKeepDays, _resetPruneMarker } from "../src/usage/record.js";

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