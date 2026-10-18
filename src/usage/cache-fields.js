/**
 * 上游 usage 里的「缓存读数」候选链 —— 全仓单一来源。
 *
 * 为什么独立成档：同一份上游 usage 有**两个**消费方，两边的候选顺序必须一字不差，
 * 否则「/v1/messages 的客户端 usage」与「我们自己的日志/报表」会各说一套：
 *   · `src/anthropic/translate.js` → Anthropic 形状的 client usage；
 *   · `src/metrics.js`（extractUsageFromJson）→ detail.usage / usage/*.jsonl / -stats。
 *
 * 候选顺序与语义照抄 cc-switch（`providers/transform.rs:760-798`）：
 *  · 命中（cache read）：`cache_read_input_tokens` → `input_tokens_details.cached_tokens`
 *    → `prompt_tokens_details.cached_tokens` → `prompt_cache_hit_tokens`（DeepSeek 系）。
 *    **每环必须「存在且 > 0」才采信**：有些中转把靠前字段硬编码桩 0，真命中只出现在后面的
 *    字段里（cc-switch #8045/#8041，否则命中被 0 掩蔽）。全链无 >0 命中 → 0（＝没有可用命中读数）。
 *  · 写入（cache creation）：`cache_creation_input_tokens` → `prompt_tokens_details.cache_write_tokens`
 *    → `input_tokens_details.cache_write_tokens`。这里**显式 0 也算已报**（与命中相反），
 *    故全链无字段时返回 null 表示「上游没报」，0 表示「报了 0」。
 */

const num = (v) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * 缓存命中（读）token 数：候选须「存在且 >0」才采信，未发现命中返回 0。
 * @param {any} usage 上游原始 usage 对象
 * @returns {number}
 */
export function cacheReadTokens(usage) {
  const u = usage && typeof usage === "object" ? usage : {};
  const candidates = [
    u.cache_read_input_tokens,
    u.input_tokens_details?.cached_tokens,
    u.prompt_tokens_details?.cached_tokens,
    u.prompt_cache_hit_tokens,
  ];
  for (const v of candidates) {
    const n = num(v);
    if (n != null && n > 0) return n;
  }
  return 0;
}

/**
 * 缓存写入（creation）token 数：任一候选字段存在即以它为准（显式 0 也算已报）；全缺返回 null。
 * @param {any} usage 上游原始 usage 对象
 * @returns {number|null}
 */
export function cacheWriteTokens(usage) {
  const u = usage && typeof usage === "object" ? usage : {};
  const candidates = [
    u.cache_creation_input_tokens,
    u.prompt_tokens_details?.cache_write_tokens,
    u.input_tokens_details?.cache_write_tokens,
  ];
  for (const v of candidates) {
    const n = num(v);
    if (n != null) return n;
  }
  return null;
}
