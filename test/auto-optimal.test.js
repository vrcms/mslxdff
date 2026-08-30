import { test } from "node:test";
import assert from "node:assert/strict";
import { rankModels } from "../src/auto.js";

// Seam: rankModels (highest seam, pure function, no I/O)
test("rankModels: 上次成功在非冷却时置顶（勾选池内谁快用谁）", () => {
  const now = Date.now();
  const ids = ["a-free", "b-free", "c-free"];
  const errors = {
    "a-free": { status: "error", at: now - 120000, slow: false }, // 旧错，不冷却
    "b-free": { status: "error", at: now - 120000, slow: false },
    "c-free": { status: "normal", at: now - 1000, slow: false }, // 最近成功
  };
  const ranked = rankModels(ids, errors, { now, cooldownMs: 60000, slowCooldownMs: 300000, latencies: {}, preferred: "a-free" });
  assert.equal(ranked[0], "c-free", "lastSuccess 应置顶，即使不是 preferred");
});

test("rankModels: slow 的 lastSuccess 在 5min 冷却期内失效", () => {
  const now = Date.now();
  const ids = ["slow-free", "fast-free"];
  const errors = {
    "slow-free": { status: "normal", at: now - 1000, slow: true }, // 刚成功但慢，被 5min 熔断
    "fast-free": { status: "normal", at: now - 5000, slow: false },
  };
  // slow 虽是 lastSuccess，但 slow:true 且在 5min 内，应被 cooling 淘汰
  const ranked = rankModels(ids, errors, { now, cooldownMs: 60000, slowCooldownMs: 300000, latencies: { "fast-free": { emaMs: 100 } } });
  assert.equal(ranked[0], "fast-free", "slow 的 lastSuccess 在冷却期内应让位");
  assert.equal(ranked[ranked.length - 1], "slow-free");
});

test("rankModels: Provider 级熔断（连续 3 模型 429）", () => {
  const now = Date.now();
  const ids = ["workbuddy/hy3", "workbuddy/hy4", "clinebot/deepseek"];
  const errors = {
    "workbuddy/hy3": { status: "limit", at: now - 1000, slow: false },
    "workbuddy/hy4": { status: "limit", at: now - 2000, slow: false },
    "workbuddy/glm": { status: "limit", at: now - 3000, slow: false },
  };
  // workbuddy 旗下 3 模型均 limit，整 Provider 应视为 cooling（由上层 providerHealth 注入，此处模拟为全部 cooling）
  const ranked = rankModels(ids, errors, { now, cooldownMs: 60000, slowCooldownMs: 300000 });
  // workbuddy 两个都在冷却，clinebot 不在冷却，应置顶
  assert.equal(ranked[0], "clinebot/deepseek");
});

test("rankModels: 勾选池内按 latency 排序", () => {
  const now = Date.now();
  const ids = ["sensenova/deepseek", "sensenova/glm-5.2"];
  const errors = {
    "sensenova/deepseek": { status: "normal", at: now - 10000 },
    "sensenova/glm-5.2": { status: "normal", at: now - 10000 },
  };
  const latencies = {
    "sensenova/deepseek": { emaMs: 800 },
    "sensenova/glm-5.2": { emaMs: 1400 },
  };
  const ranked = rankModels(ids, errors, { now, cooldownMs: 60000, latencies });
  assert.equal(ranked[0], "sensenova/deepseek", "latency 低的优先");
});
