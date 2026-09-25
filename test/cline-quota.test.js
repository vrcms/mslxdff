import { test } from "node:test";
import assert from "node:assert/strict";
import { formatQuota, handleClineQuota } from "../src/cli/commands/provider/cline-quota.js";

test("quota: 空账本给空状态引导", () => {
  const s = formatQuota([]);
  assert.ok(s.includes("账本为空"), "空状态必须说明原因");
  assert.ok(s.includes("-provider cline quota"), "空状态必须给下一步");
});

test("quota: free/pass 双口径分组渲染", () => {
  const s = formatQuota([
    { accountId: "a1", model: "cline-free/gemini-3.8-flash", modelType: "free", currentCycleTokens: 29, completedCycles: 1, lastCompletedCycleTokens: 0, last24hTokens: 29, totalTokens: 29 },
    { accountId: "a1", model: "cline-pass/kimi-k3", modelType: "pass", currentCycleTokens: 0, completedCycles: 0, lastCompletedCycleTokens: 0, last24hTokens: 42, totalTokens: 100 },
  ]);
  assert.ok(s.includes("[a1]"), "按账号分组");
  assert.ok(s.includes("本周期 29"), "free 走周期口径");
  assert.ok(s.includes("近24h 42"), "pass 走 24h 口径");
});

test("quota: 非 cline/非 quota 子命令直接让路", async () => {
  assert.equal(await handleClineQuota("openrouter", "quota"), false);
  assert.equal(await handleClineQuota("cline", "models"), false);
});
