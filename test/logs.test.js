import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendCall,
  appendError,
  appendEvent,
  recentEvents,
  recentCalls,
  lastError,
  recentErrors,
  callsFile,
  errorsFile,
  eventsFile,
} from "../src/logs.js";
import { appendCall as defaultAppendCall, recentCalls as defaultRecentCalls } from "../src/logs.js";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "mslxdff-logs-"));
}

test("appendCall writes JSON lines and recentCalls reads them back", () => {
  const dir = tmpDir();
  const file = join(dir, "calls.log");
  appendCall({ model: "a", status: 200, durationMs: 10 }, { file });
  appendCall({ model: "b", status: 200, durationMs: 20 }, { file });
  appendCall({ model: "c", status: 500, durationMs: 30 }, { file });
  const calls = recentCalls(2, { file });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, "b");
  assert.equal(calls[1].model, "c");
  assert.equal(calls[1].status, 500);
});

test("recentCalls n larger than entries returns all", () => {
  const dir = tmpDir();
  const file = join(dir, "calls.log");
  appendCall({ model: "a" }, { file });
  const calls = recentCalls(5, { file });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "a");
});

test("appendError records and lastError returns most recent", () => {
  const dir = tmpDir();
  const file = join(dir, "errors.log");
  assert.equal(lastError({ file }), null);
  appendError({ model: "a", status: 429, message: "rate limited" }, { file });
  appendError({ model: "b", status: 500, message: "boom" }, { file });
  const err = lastError({ file });
  assert.equal(err.model, "b");
  assert.equal(err.message, "boom");
  const errs = recentErrors(2, { file });
  assert.equal(errs.length, 2);
});

test("entries carry an ISO timestamp", () => {
  const dir = tmpDir();
  const file = join(dir, "calls.log");
  appendCall({ model: "a", status: 200 }, { file });
  const call = recentCalls(1, { file })[0];
  assert.ok(!Number.isNaN(Date.parse(call.ts)), "ts must be parseable");
});

test("missing log files yield empty results", () => {
  const dir = tmpDir();
  assert.deepEqual(recentCalls(5, { file: join(dir, "nope.log") }), []);
  assert.equal(lastError({ file: join(dir, "nope-err.log") }), null);
  assert.deepEqual(recentEvents(5, { file: join(dir, "nope-events.log") }), []);
});

test("appendEvent writes JSON lines and recentEvents reads them back", () => {
  const dir = tmpDir();
  const file = join(dir, "events.log");
  appendEvent({ type: "request", model: "a", hops: 1 }, { file });
  appendEvent({ type: "upstream-error", model: "a", status: 429 }, { file });
  appendEvent({ type: "peer-forward", peer: "x", model: "b" }, { file });
  appendEvent({ type: "result", model: "b", status: 200, via: "peer" }, { file });
  const events = recentEvents(2, { file });
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "peer-forward");
  assert.equal(events[0].peer, "x");
  assert.equal(events[1].type, "result");
  assert.equal(events[1].via, "peer");
  assert.ok(!Number.isNaN(Date.parse(events[0].ts)), "ts must be parseable");
});

// BUG-10：溢出回退必须按**字节**保留，不得断崖到固定行数（旧 slice(-100) 一次丢 90% 容量）
test("events 溢出后按字节保留末尾大部分，而非断崖到 100 行", () => {
  const dir = tmpDir();
  const file = join(dir, "events.log");
  // 每行 ~1KB（贴近现网均值），写 2000 行 ≈ 2MB，超过 1MB 阈值必触发裁剪
  const pad = "x".repeat(900);
  for (let i = 0; i < 2000; i++) appendEvent({ type: "request", seq: i, detail: { talkChars: 0, pad } }, { file });
  const raw = readFileSync(file, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  // 旧行为：恰好 99~100 行；新行为：按预算保留，行数远超 100
  assert.ok(lines.length > 500, `裁剪后应保留远超 100 行，实际 ${lines.length}`);
  // 且保留的是**末尾**：最后一行必须是最后写入的那条
  assert.equal(JSON.parse(lines[lines.length - 1]).seq, 1999);
  // 不得截半行：每一行都还得是合法 JSON
  for (const l of lines.slice(-5)) JSON.parse(l);
});

test("module-level default helpers use the same state dir", async () => {
  // sanity: importing the default file helpers works and persists to disk
  const dir = tmpDir();
  process.env.MSLXDFF_DAEMON_DIR = dir;
  try {
    defaultAppendCall({ model: "z", status: 200 });
    assert.ok(existsSync(callsFile()));
    const calls = defaultRecentCalls(1);
    assert.equal(calls[0].model, "z");
    assert.ok(readFileSync(callsFile(), "utf8").length > 0);
  } finally {
    delete process.env.MSLXDFF_DAEMON_DIR;
  }
});
