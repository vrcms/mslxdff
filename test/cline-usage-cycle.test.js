import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordOutput, recordLimit, exactOutputTokens, isFreeModel, aggregateUsage, FREE_WINDOW,
  computeOutputRow,
} from "../src/providers/cline/usage.js";
import { clearStateCache } from "../src/state/store.js";

const DAY = 24 * 3600 * 1000;

function tmpFile(name = "state.json") {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-"));
  return join(dir, name);
}

// ===================== 双口径：isFreeModel 判定 =====================
test("isFreeModel: free 通道识别（前缀/后缀/已知免费）", () => {
  assert.equal(isFreeModel("cline-free/deepseek-v4.1-flash"), true);
  assert.equal(isFreeModel("poolside/laguna-s-2.1:free"), true);
  assert.equal(isFreeModel("meta/muse-spark-1.3-contributor"), true, "muse-spark 已知免费");
  assert.equal(isFreeModel("stealth/space-bunny-alpha"), true, "space-bunny 已知免费");
  assert.equal(isFreeModel("cline-free/solar-pro4"), true);
});

test("isFreeModel: pass 通道识别", () => {
  assert.equal(isFreeModel("cline-pass/deepseek-v4-pro"), false);
  assert.equal(isFreeModel("cline-pass/mimo-v2.6-flash"), false);
  assert.equal(isFreeModel("cline-pass/kimi-k3"), false);
});

// ===================== 双口径：aggregateUsage free 按周期 =====================
test("aggregate[free]: 当前周期从限额恢复后重新计", () => {
  const now = Date.now();
  const rows = [
    { type: "output", at: now - 5 * DAY, accountId: "a1", model: "cline-free/x", outputTokens: 10, cycleOutputTokens: 10, cycleCount: 1 },
    { type: "limit", at: now - 4 * DAY, accountId: "a1", model: "cline-free/x", cycleOutputTokens: 10, cycleCount: 1, until: now - 3 * DAY, reason: "daily_limit" },
    { type: "output", at: now - 2 * DAY, accountId: "a1", model: "cline-free/x", outputTokens: 7, cycleOutputTokens: 7, cycleCount: 2 },
    { type: "output", at: now - 1 * DAY, accountId: "a1", model: "cline-free/x", outputTokens: 3, cycleOutputTokens: 10, cycleCount: 2 },
  ];
  const e = aggregateUsage(rows, now).get("a1|cline-free/x");
  assert.equal(e.modelType, "free");
  assert.equal(e.completedCycles, 1, "已封存周期数");
  assert.equal(e.lastCompletedCycleTokens, 10, "上一完整周期=10");
  assert.equal(e.currentCycleTokens, 10, "当前(恢复后)周期累计=7+3=10");
  assert.equal(e.totalTokens, 20, "全部累计=20");
});

test("aggregate[free]: 仍在首个未封存周期内", () => {
  const now = Date.now();
  const rows = [
    { type: "output", at: now - 3600e3, accountId: "a2", model: "meta/muse-spark-1.3-contributor", outputTokens: 5, cycleOutputTokens: 5, cycleCount: 1 },
    { type: "output", at: now - 1800e3, accountId: "a2", model: "meta/muse-spark-1.3-contributor", outputTokens: 5, cycleOutputTokens: 10, cycleCount: 1 },
  ];
  const e = aggregateUsage(rows, now).get("a2|meta/muse-spark-1.3-contributor");
  assert.equal(e.modelType, "free");
  assert.equal(e.completedCycles, 0);
  assert.equal(e.currentCycleTokens, 10, "限额恢复后→此刻 之间=10");
  assert.equal(e.totalTokens, 10);
});

// ===================== 双口径：aggregateUsage pass 按最近 24h =====================
test("aggregate[pass]: 只计最近24h，窗口外忽略", () => {
  const now = Date.now();
  const rows = [
    { type: "output", at: now - DAY - 3600e3, accountId: "p1", model: "cline-pass/deepseek-v4-pro", outputTokens: 999, cycleOutputTokens: 999, cycleCount: 1 },
    { type: "output", at: now - 20 * 3600e3, accountId: "p1", model: "cline-pass/deepseek-v4-pro", outputTokens: 100, cycleOutputTokens: 1099, cycleCount: 1 },
    { type: "output", at: now - 2 * 3600e3, accountId: "p1", model: "cline-pass/deepseek-v4-pro", outputTokens: 50, cycleOutputTokens: 1149, cycleCount: 1 },
  ];
  const e = aggregateUsage(rows, now).get("p1|cline-pass/deepseek-v4-pro");
  assert.equal(e.modelType, "pass");
  assert.equal(e.last24hTokens, 150, "窗口内=100+50，窗口外999忽略");
  assert.equal(e.totalTokens, 1149, "全时段总和仍记录（含窗口外）");
});

test("aggregate[pass]: 24h 边界（恰在窗口内保留）", () => {
  const now = Date.now();
  const rows = [
    { type: "output", at: now - DAY + 1000, accountId: "p2", model: "cline-pass/kimi-k3", outputTokens: 42, cycleOutputTokens: 42, cycleCount: 1 },
    { type: "output", at: now - DAY - 1000, accountId: "p2", model: "cline-pass/kimi-k3", outputTokens: 7, cycleOutputTokens: 49, cycleCount: 1 },
  ];
  const e = aggregateUsage(rows, now).get("p2|cline-pass/kimi-k3");
  assert.equal(e.last24hTokens, 42, "窗口内仅 42");
});

test("aggregate: 同账号既有 free 又有 pass 分别独立统计", () => {
  const now = Date.now();
  const rows = [
    { type: "output", at: now - 3600e3, accountId: "mix", model: "cline-free/glm-5.3-flash", outputTokens: 11, cycleOutputTokens: 11, cycleCount: 1 },
    { type: "output", at: now - 3600e3, accountId: "mix", model: "cline-pass/glm-5.3", outputTokens: 22, cycleOutputTokens: 22, cycleCount: 1 },
  ];
  const agg = aggregateUsage(rows, now);
  assert.equal(agg.get("mix|cline-free/glm-5.3-flash").currentCycleTokens, 11);
  assert.equal(agg.get("mix|cline-free/glm-5.3-flash").modelType, "free");
  assert.equal(agg.get("mix|cline-pass/glm-5.3").last24hTokens, 22);
  assert.equal(agg.get("mix|cline-pass/glm-5.3").modelType, "pass");
});

// ===================== 流式旁路：Response 挂载账号（cline/chat.js → relay-pipeline.js）====================
// 原 reqId 登记表方案已删除：多一跳且无消费方。现方案是 provider 把账号哈希直接挂在透传 Response
// 的 clineAccountId 字段上（转发链路不读），relay 用 computeOutputRow + recordOutput 记账。
// 此处只测“挂载字段存在即能记账”的约定，不测传输细节。

// ===================== 纯函数：computeOutputRow =====================
test("computeOutputRow: 精确 usage tokens（estimated=false）", () => {
  const row = computeOutputRow({ model: "cline-free/deepseek-v4.1-flash", accountId: "acct_abc", usage: { completion_tokens: 42, prompt_tokens: 100 }, chars: null });
  assert.equal(row.accountId, "acct_abc");
  assert.equal(row.outputTokens, 42);
  assert.equal(row.estimated, false, "有精确 usage → estimated false");
  assert.equal(row.model, "cline-free/deepseek-v4.1-flash");
});

test("computeOutputRow: 无 usage 时按 chars 估算（estimated=true）", () => {
  const row = computeOutputRow({ model: "cline-pass/kimi-k3", accountId: "acct_def", usage: null, chars: 160 });
  assert.equal(row.outputTokens, 40, "chars/4");
  assert.equal(row.estimated, true, "无 usage → estimated true");
});

test("computeOutputRow: 零/负 token 或缺 model → null（跳过记账）", () => {
  assert.equal(computeOutputRow({ model: "x", usage: { completion_tokens: 0 }, chars: null }), null);
  assert.equal(computeOutputRow({ model: "x", usage: { completion_tokens: -5 }, chars: null }), null);
  assert.equal(computeOutputRow({ model: "x", usage: {}, chars: 0 }), null);
  assert.equal(computeOutputRow({ usage: { completion_tokens: 10 } }), null, "缺 model → null");
});

test("computeOutputRow: 缺 accountId 落 unknown 而非崩溃", () => {
  const row = computeOutputRow({ model: "cline-free/x", usage: { completion_tokens: 5 } });
  assert.equal(row.accountId, "unknown");
  assert.equal(row.outputTokens, 5);
});

// ===================== e2e：recordOutput 落 modelType（写真实 tmp logDir）=====================
test("e2e: recordOutput 写入的行含 modelType", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-agg-"));
  const prevDataDir = process.env.MSLXDFF_DAEMON_DIR;
  process.env.MSLXDFF_DAEMON_DIR = dir; // logDir() 走这个 env（见 logs.js）
  clearStateCache();
  try {
    const rFree = await recordOutput({ accountId: "acctF", model: "cline-free/deepseek-v4.1-flash", tokens: 12, estimated: false });
    assert.equal(rFree.modelType, "free", "output 行需落 modelType");
    const rPass = await recordOutput({ accountId: "acctP", model: "cline-pass/deepseek-v4-pro", tokens: 34, estimated: false });
    assert.equal(rPass.modelType, "pass");
    const jsonl = readFileSync(join(dir, "cline-usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(jsonl.length, 2, "两行落盘");
    assert.ok(jsonl.every((r) => r.modelType === "free" || r.modelType === "pass"));
  } finally {
    if (prevDataDir === undefined) delete process.env.MSLXDFF_DAEMON_DIR;
    else process.env.MSLXDFF_DAEMON_DIR = prevDataDir;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

// ===================== 回归：recordLimit 仅封 free =====================
test("recordLimit: 仅封 free，pass 走 24h 不受周期影响", () => {
  const now = Date.now();
  const rows = [
    { type: "output", at: now - 3600e3, accountId: "pl", model: "cline-pass/x", outputTokens: 5, cycleOutputTokens: 5, cycleCount: 1 },
    { type: "limit", at: now - 1800e3, accountId: "pl", model: "cline-pass/x", cycleOutputTokens: 5, cycleCount: 1, until: now + DAY, reason: "daily_limit" },
  ];
  const e = aggregateUsage(rows, now).get("pl|cline-pass/x");
  assert.equal(e.modelType, "pass");
  assert.equal(e.last24hTokens, 5, "pass 仍按 24h 计 output，limit 行不减计");
});

test("exactOutputTokens: 兼容四字段名 + 非数返回 0", () => {
  assert.equal(exactOutputTokens({ completion_tokens: 123 }), 123);
  assert.equal(exactOutputTokens({ output_tokens: 7 }), 7);
  assert.equal(exactOutputTokens({ completion_tokens: "0" }), 0);
  assert.equal(exactOutputTokens(null), 0);
});

// ===================== 回归：relay 组合调用 computeOutputRow → recordOutput 必须落盘 =====================
// 2026-09-25 gemini 流式零记账：computeOutputRow 回 outputTokens，recordOutput 只认 tokens，
// 组合调用静默返回 null。relay-pipeline.js:222 即此组合。
test("e2e: computeOutputRow 的输出直接喂 recordOutput 能落盘", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-agg-"));
  const prevDataDir = process.env.MSLXDFF_DAEMON_DIR;
  process.env.MSLXDFF_DAEMON_DIR = dir;
  clearStateCache();
  try {
    const orow = computeOutputRow({ model: "cline-free/gemini-3.8-flash", accountId: "acct_g", usage: { completion_tokens: 42, prompt_tokens: 100 }, chars: 160 });
    const saved = await recordOutput(orow);
    assert.ok(saved, "组合调用必须返回行，不能静默 null");
    assert.equal(saved.outputTokens, 42);
    const jsonl = readFileSync(join(dir, "cline-usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(jsonl.length, 1, "一行落盘");
    assert.equal(jsonl[0].model, "cline-free/gemini-3.8-flash");
  } finally {
    if (prevDataDir === undefined) delete process.env.MSLXDFF_DAEMON_DIR;
    else process.env.MSLXDFF_DAEMON_DIR = prevDataDir;
    clearStateCache();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
