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

// —— 表格呈现（spec 四态 / 覆盖度可见 / 文案一致）——
function mkModel(id, over = {}) {
  return {
    id, requests: 3, promptTokens: 100, completionTokens: 200, totalTokens: 300,
    reasoningTokens: 0, reasoningSource: "none", reasoningChars: 0,
    avgTtfbMs: null, avgTotalMs: 900, avgTps: 40, ttfSamples: 0, streamRequests: 0,
    ...over,
  };
}

function cellOf(text, id, col, table = "token") {
  // 两张表都有模型 id：Token 表 6 列（split 后 8 段）、性能表 5 列（7 段）——按段数区分，别拿错表
  const want = table === "token" ? 8 : 7;
  const parts = text.split("\n").map((l) => l.split("│")).find((p) => p.length === want && p[1].trim() === id);
  assert.ok(parts, `找不到${table}表的行：${id}`);
  return parts.map((c) => c.trim())[col];
}

test("思考列四态：精确无标 / 估算带 ~ / 真 0 显示 0 / 未知显示 —", () => {
  const report = {
    windowHours: 24,
    models: [
      mkModel("m/reported", { reasoningTokens: 1500, reasoningSource: "reported" }),
      mkModel("m/estimated", { reasoningTokens: 1200, reasoningSource: "estimated", reasoningChars: 4800 }),
      mkModel("m/zero", { reasoningTokens: 0, reasoningSource: "reported" }),
      mkModel("m/none", { reasoningTokens: 0, reasoningSource: "none" }),
    ],
    totals: mkModel("合计", { reasoningTokens: 2700, reasoningSource: "mixed", requests: 12 }),
  };
  const text = renderStats(report, { hours: 24 });
  assert.equal(cellOf(text, "m/reported", 5), "1.5k", "上报值不加 ~");
  assert.equal(cellOf(text, "m/estimated", 5), "1.2k~", "估算必须带 ~");
  assert.equal(cellOf(text, "m/zero", 5), "0", "真没思考才是 0");
  assert.equal(cellOf(text, "m/none", 5), "—", "未知不得渲染成 0（fmtTok 的 Number(null)||0 陷阱）");
  assert.equal(cellOf(text, "合计", 5), "2.7k~", "混合来源整列标 ~");
});

test("性能表新增「首字样本」列，显示 样本数/流式请求数", () => {
  const report = {
    windowHours: 24,
    models: [
      mkModel("m/ok", { ttfSamples: 3, streamRequests: 3, avgTtfbMs: 12_400 }),
      mkModel("m/partial", { ttfSamples: 4, streamRequests: 1249, avgTtfbMs: 1 }),
      mkModel("m/nosample", { ttfSamples: 0, streamRequests: 0, avgTtfbMs: null }),
    ],
    totals: mkModel("合计", { ttfSamples: 7, streamRequests: 1252, avgTtfbMs: 12_400 }),
  };
  const text = renderStats(report, { hours: 24 });
  assert.match(text, /首字样本/, "表头必须出现新列");
  assert.equal(cellOf(text, "m/ok", 5, "perf"), "3/3");
  assert.equal(cellOf(text, "m/partial", 5, "perf"), "4/1249", "零星样本要一眼看出来");
  assert.equal(cellOf(text, "m/nosample", 5, "perf"), "0/0");
  assert.equal(cellOf(text, "m/nosample", 2, "perf"), "—", "无样本时首字显示 —");
  assert.equal(cellOf(text, "m/partial", 2, "perf"), "1ms");
});

test("表脚口径文案说明 ~ / — / 0 与「不同源」", () => {
  const report = {
    windowHours: 24,
    models: [mkModel("m/a", { reasoningTokens: 20, reasoningSource: "estimated", ttfSamples: 1, streamRequests: 2, avgTtfbMs: 800 })],
    totals: mkModel("合计", { reasoningTokens: 20, reasoningSource: "estimated", ttfSamples: 1, streamRequests: 2, avgTtfbMs: 800 }),
  };
  const text = renderStats(report, { hours: 24 });
  assert.match(text, /首字 = 本次上游尝试/, "首字定义要写清量的是哪一段");
  assert.match(text, /~.*估算|估算.*~/, "必须解释 ~ 是估算");
  assert.match(text, /—.*未|未.*—/, "必须解释 — 是未上报且无可估内容");
  assert.match(text, /不同源/, "必须说明与 -status/-model stats 不同源");
});