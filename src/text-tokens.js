// `/v1/messages` 面 token 估算的单一来源（ADR-0055）：`count_tokens` 读数与响应 `usage` 兜底共用一个公式。
// 共用面：`src/anthropic/count-tokens.js`（请求侧逐段累加，走 `estimateTextTokens`）、
// `src/anthropic/translate.js`（上游未报 usage 时的兜底与流式生成侧累计，走 `createTokenCounter`）。
// 两处必须同源，否则 `count_tokens` 与响应 `usage` 会各说一套读数
// —— 同 ADR-0053 把 effort 词表收成单一来源的理由。
//
// 公式照抄参照实现 `wb_proxy.py:12841-12848`：`cjk + max(1, int(other / 3.6))`（空文本 0），
// CJK 区间 = \u4e00-\u9fff 主区 + \u3400-\u4dbf 扩展 A。自造系数＝造第二个真相源（design.md 决策 2）。
// 实现不抄 `re.sub` 再数长度差：那要额外分配一份与原文等长的新串，本实现单遍扫描、无分配。
// 与 Python 的两处已知差异（不影响本仓自洽，但别写成「逐值相等」）：① astral 字符（emoji）JS 按
// 2 个 UTF-16 单元计、Python 按 1 个码点计 —— emoji 密集文本可差到 2 倍以上；② falsy 非串（`0`/`false`）
// Python 直接返回 0、本实现按 `String()` 后非空计 ≥1。现所有调用方传的都是字符串，两条均不可达。

const CJK_HI_START = 0x4e00;
const CJK_HI_END = 0x9fff; // 主区，占实际中文文本的绝对多数
const CJK_EXT_A_START = 0x3400;
const CJK_EXT_A_END = 0x4dbf;
const OTHER_CHARS_PER_TOKEN = 3.6;

/**
 * 跨多段累计的计数器。逐段各套一次公式会把参照实现的 `max(1, …)` 下限乘上段数
 * （流式按 1~3 字一帧下发时，1000 个 ASCII 字会被估成 1000 tokens 而非 277），
 * 所以累计的是字数、最后一次性套公式。
 * @returns {{ add: (text: unknown) => void, tokens: () => number }}
 */
export function createTokenCounter() {
  let cjk = 0;
  let other = 0;
  return {
    add(text) {
      if (text == null) return;
      const s = typeof text === "string" ? text : String(text);
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= CJK_HI_START && c <= CJK_HI_END) cjk++;
        else if (c >= CJK_EXT_A_START && c <= CJK_EXT_A_END) cjk++;
        else other++;
      }
    },
    tokens() {
      if (cjk + other <= 0) return 0; // 空文本给 0，不吃 +1 下限
      return cjk + Math.max(1, Math.floor(other / OTHER_CHARS_PER_TOKEN));
    },
  };
}

/** 单段文本的 token 估算（CJK 每字 1 token，其余每 3.6 字符 1 token，非空至少 1）。 */
export function estimateTextTokens(text) {
  const counter = createTokenCounter();
  counter.add(text);
  return counter.tokens();
}
