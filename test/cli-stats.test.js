import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isStatsFlag, parseStatsArgs, renderStats, handleStats } from "../src/cli/commands/stats.js";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "mslxdff-test-clistats-"));
}

test("isStatsFlag 只认 -stats/--stats，不误触 -status / -model stats", () => {
  assert.equal(isStatsFlag(["-stats"]), true);
  assert.equal(isStatsFlag(["--stats"]), true);
  assert.equal(isStatsFlag(["-status"]), false);
  assert.equal(isStatsFlag(["--status"]), false);
  assert.equal(isStatsFlag(["-s"]), false);
  assert.equal(isStatsFlag(["-model", "stats"]), false);
  assert.equal(isStatsFlag([]), false);
});

test("parseStatsArgs：默认 24h，--hours 生效并封顶 168，--model/--json", () => {
  assert.deepEqual(parseStatsArgs(["-stats"]), { hours: 24, model: null, json: false });
  assert.deepEqual(parseStatsArgs(["-stats", "--hours", "1"]), { hours: 1, model: null, json: false });
  assert.equal(parseStatsArgs(["-stats", "--hours", "999"]).hours, 168);
  assert.equal(parseStatsArgs(["-stats", "--hours", "abc"]).hours, 24, "非法值回退 24");
  assert.equal(parseStatsArgs(["-stats", "--hours", "0"]).hours, 24);
  assert.equal(parseStatsArgs(["-stats", "--model", "a/b"]).model, "a/b");
  assert.equal(parseStatsArgs(["-stats", "--json"]).json, true);
});

test("renderStats 空状态给人话引导，不是空表", () => {
  const text = renderStats({ models: [], totals: { requests: 0 } }, { hours: 24 });
  assert.match(text, /暂无用量记录/);
  assert.match(text, /24h/);
  assert.match(text, /-chat 直连/);
  assert.doesNotMatch(text, /模型\s+请求/, "空状态不该打印表头");
});

test("renderStats 有数据：边框表格展示全部聚合列，长模型名不挤乱列位", () => {
  const report = {
    windowHours: 24,
    models: [
      { id: "opencode/big-pickle", requests: 3, promptTokens: 1500, completionTokens: 4200, totalTokens: 5700, reasoningTokens: 10, avgTtfbMs: 2100, avgTotalMs: 18400, avgTps: 86.2 },
      { id: "cline/cline-free/super-long-model-name-for-column-alignment", requests: 1, promptTokens: 20, completionTokens: 5, totalTokens: 25, reasoningTokens: 7, avgTtfbMs: null, avgTotalMs: 300, avgTps: null },
    ],
    totals: { requests: 4, promptTokens: 1520, completionTokens: 4205, totalTokens: 5725, reasoningTokens: 17, avgTtfbMs: 2100, avgTotalMs: 9000, avgTps: 90 },
  };
  const text = renderStats(report, { hours: 24 });
  assert.match(text, /模型用量报告（近 24h）/);
  assert.match(text, /成功请求：4 次 · 模型：2 个/);
  assert.match(text, /Token 用量/);
  assert.match(text, /响应性能/);
  assert.match(text, /┌/);
  assert.match(text, /┬/);
  assert.match(text, /┐/);
  assert.match(text, /opencode\/big-pickle/);
  assert.match(text, /cline\/cline-free\/super-long-model-name-for-column-alignment/);
  assert.match(text, /1\.5k/);
  assert.match(text, /86\.2 tok\/s/);
  assert.match(text, /│\s+10\s+│/, "每个模型的思考 tokens 应进入表格");
  assert.match(text, /│\s+7\s+│/);
  assert.match(text, /合计/);
  assert.match(text, /加权/);

  const lines = text.split("\n");
  const rows = lines.filter((line) => line.includes("opencode/big-pickle") || line.includes("cline/cline-free/super-long"));
  const displayWidth = (line) => [...line].reduce((sum, ch) => sum + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1), 0);
  for (const row of rows) {
    const rowIdx = lines.indexOf(row);
    assert.equal(displayWidth(row), displayWidth(lines[rowIdx - 2]), "长模型名不能越界破坏列对齐");
  }
});

test("renderStats：无 usage 的模型速度显示 —— 而不是 NaN", () => {
  const report = {
    windowHours: 1,
    models: [{ id: "m/x", requests: 1, promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0, avgTtfbMs: null, avgTotalMs: null, avgTps: null }],
    totals: { requests: 1, promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0, avgTtfbMs: null, avgTotalMs: null, avgTps: null },
  };
  const text = renderStats(report, { hours: 1 });
  assert.match(text, /—/);
  assert.doesNotMatch(text, /NaN|undefined/);
});

test("handleStats 无 flag 时返回 false（不吞其他命令）", async () => {
  assert.equal(await handleStats(["-status"]), false);
  assert.equal(await handleStats([]), false);
});

test("handleStats 端到端：写 usage 文件后打印报表", async () => {
  const dir = tmpDir();
  const prevDir = process.env.MSLXDFF_DAEMON_DIR;
  try {
    process.env.MSLXDFF_DAEMON_DIR = dir;
    const u = join(dir, "usage");
    mkdirSync(u, { recursive: true });
    const now = Date.now();
    const d = new Date(now);
    const f = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.jsonl`;
    writeFileSync(join(u, f), [
      JSON.stringify({ ts: now - 60_000, model: "opencode/big-pickle", prompt_tokens: 100, completion_tokens: 200, total_tokens: 300, ttfbMs: 100, totalMs: 1100 }),
      JSON.stringify({ ts: now - 30_000, model: "opencode/big-pickle", prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, ttfbMs: 100, totalMs: 200 }),
    ].join("\n") + "\n");
    const text = await (async () => {
      const out = [];
      const orig = console.log;
      console.log = (...a) => out.push(a.join(" "));
      try { await handleStats(["-stats", "--hours", "1"]); } finally { console.log = orig; }
      return out.join("\n");
    })();
    assert.match(text, /opencode\/big-pickle/);
    assert.match(text, /成功请求：2 次/);
  } finally {
    if (prevDir === undefined) delete process.env.MSLXDFF_DAEMON_DIR; else process.env.MSLXDFF_DAEMON_DIR = prevDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handleStats --json 输出可解析的报表对象", async () => {
  const dir = tmpDir();
  const prevDir = process.env.MSLXDFF_DAEMON_DIR;
  try {
    process.env.MSLXDFF_DAEMON_DIR = dir;
    const text = await (async () => {
      const out = [];
      const orig = console.log;
      console.log = (...a) => out.push(a.join(" "));
      try { await handleStats(["-stats", "--json"]); } finally { console.log = orig; }
      return out.join("\n");
    })();
    const parsed = JSON.parse(text);
    assert.equal(parsed.windowHours, 24);
    assert.deepEqual(parsed.models, []);
  } finally {
    if (prevDir === undefined) delete process.env.MSLXDFF_DAEMON_DIR; else process.env.MSLXDFF_DAEMON_DIR = prevDir;
    rmSync(dir, { recursive: true, force: true });
  }
});