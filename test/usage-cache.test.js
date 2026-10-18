// 缓存读数的观测面（ADR-0062 后续）：候选链单一来源 → 日志投影 → usage 行 → 窗口聚合 → -stats 渲染。
// 为什么单独立测：这四层里任何一层漏字段，命中率就永远显示不出来（改前就是这么丢的）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheReadTokens, cacheWriteTokens } from "../src/usage/cache-fields.js";
import { extractUsageFromJson } from "../src/metrics.js";
import { recordChatUsage } from "../src/usage/record.js";
import { aggregateUsage } from "../src/usage/report.js";
import { renderStats } from "../src/cli/commands/stats.js";

test("cache-fields：命中候选须「存在且 >0」，显式 0 视为未报、继续往后找", () => {
  assert.equal(cacheReadTokens({ prompt_cache_hit_tokens: 384 }), 384);
  // 靠前字段被中转硬编码桩 0：必须继续往后找（cc-switch #8045/#8041）
  assert.equal(cacheReadTokens({ prompt_tokens_details: { cached_tokens: 0 }, prompt_cache_hit_tokens: 60 }), 60);
  assert.equal(cacheReadTokens({ input_tokens_details: { cached_tokens: 7 } }), 7);
  assert.equal(cacheReadTokens({ cache_read_input_tokens: 0 }), 0); // 全链无 >0 → 无可用读数
  assert.equal(cacheReadTokens({ prompt_tokens: 100 }), 0);
  assert.equal(cacheReadTokens(null), 0);
});

test("cache-fields：写入候选显式 0 也算已报；全缺返回 null（未知 ≠ 0）", () => {
  assert.equal(cacheWriteTokens({ cache_creation_input_tokens: 0 }), 0);
  assert.equal(cacheWriteTokens({ prompt_tokens_details: { cache_write_tokens: 12 } }), 12);
  assert.equal(cacheWriteTokens({ input_tokens_details: { cache_write_tokens: 5 } }), 5);
  assert.equal(cacheWriteTokens({ prompt_tokens: 1 }), null);
});

test("metrics 投影：缓存字段进 detail.usage；只有缓存字段的空包仍算未报", () => {
  const hit = extractUsageFromJson({ usage: { prompt_tokens: 429, completion_tokens: 84, total_tokens: 513, prompt_cache_hit_tokens: 384 } });
  assert.equal(hit.cache_read_input_tokens, 384);
  assert.equal(hit.prompt_tokens, 429); // 上游 prompt_tokens 含命中，原样保留
  const write = extractUsageFromJson({ usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, cache_creation_input_tokens: 0 } });
  assert.equal(write.cache_creation_input_tokens, 0);
  assert.equal(extractUsageFromJson({ usage: { prompt_cache_hit_tokens: 9 } }), null);
});

test("usage 行 + 窗口聚合：命中率 = 缓存读 ÷ 输入总数；无读数给 null（渲染 —）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-usage-cache-"));
  const prev = process.env.MSLXDFF_DAEMON_DIR;
  process.env.MSLXDFF_DAEMON_DIR = dir;
  try {
    const row = await recordChatUsage({
      model: "raccoon/sn-deepseek-v4-1-flash",
      via: "local",
      usage: { prompt_tokens: 429, completion_tokens: 84, total_tokens: 513, cache_read_input_tokens: 384 },
      stream: true,
    });
    assert.equal(row.cache_read_tokens, 384);
    const plain = await recordChatUsage({ model: "m/x", usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });
    assert.equal(plain.cache_read_tokens, null); // 「上游没报」≠ 0

    const now = Date.now();
    const rep = aggregateUsage([
      { ts: now, model: "a", prompt_tokens: 100, completion_tokens: 1, cache_read_tokens: 40 },
      { ts: now, model: "a", prompt_tokens: 100, completion_tokens: 1, cache_read_tokens: null },
      { ts: now, model: "b", prompt_tokens: 50, completion_tokens: 1 },
    ]);
    assert.equal(rep.totals.cacheReadTokens, 40);
    assert.equal(rep.totals.cacheHitRate, 0.16); // 40 / 250
    assert.equal(rep.models.find((m) => m.id === "b").cacheHitRate, null);
    const out = renderStats(rep);
    assert.ok(out.includes("缓存命中"), out);
    assert.ok(out.includes("40 (16.0%)"), out);
  } finally {
    if (prev === undefined) delete process.env.MSLXDFF_DAEMON_DIR;
    else process.env.MSLXDFF_DAEMON_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
