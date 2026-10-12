// ADR-0055：/v1/messages 的 token 估算单一来源 + usage 兜底。
// 此前本模块只有寄生在 test/anthropic-translate.test.js 的 3 条断言（ADR-0053 评审 P0 点名）。
// 公式出处：参照实现 wb_proxy.py:12841-12848 `cjk + max(1, int(other / 3.6))`，CJK = \u4e00-\u9fff + 扩展A \u3400-\u4dbf。
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTextTokens } from "../src/text-tokens.js";
import { estimateTokens } from "../src/anthropic/count-tokens.js";
import { toAnthropicUsage, chatJsonToAnthropic, createAnthropicChunkTranslator } from "../src/anthropic/translate.js";

// ---------- estimateTextTokens：估算器本体 ----------

test("纯中文 1 字 ≈ 1 token，不再按 chars/4 低 4 倍", () => {
  const n = estimateTextTokens("汉".repeat(1000));
  assert.ok(n >= 1000 && n <= 1002, `实得 ${n}`);
});

test("ASCII 每 3.6 字符 1 token（与旧口径同量级）", () => {
  assert.equal(estimateTextTokens("a".repeat(1000)), Math.max(1, Math.floor(1000 / 3.6)));
});

test("空文本为 0；非空至少 1（照抄参照实现的 +1 下限语义）", () => {
  assert.equal(estimateTextTokens(""), 0);
  assert.equal(estimateTextTokens(undefined), 0);
  assert.equal(estimateTextTokens("a"), 1);
  assert.equal(estimateTextTokens("中"), 2, "cjk=1 + max(1, int(0/3.6))=1 → 2");
});

test("扩展 A 区（\\u3400-\\u4dbf）按 CJK 计", () => {
  assert.equal(estimateTextTokens("\u3400".repeat(10)), 11);
});

test("混合文本 cjk 与 other 分开计", () => {
  assert.equal(estimateTextTokens("汉汉aaaa"), 3, "2 cjk + max(1, floor(4/3.6))=1 → 3");
});

test("astral（emoji）按 UTF-16 单元计入 other（与 Python 码点计数的已知差异，见源码注释）", () => {
  assert.equal(estimateTextTokens("😀".repeat(10)), Math.max(1, Math.floor(20 / 3.6)));
});

test("非字符串输入按 String() 处理，不抛错", () => {
  assert.equal(estimateTextTokens(12345), 1);
});

// ---------- estimateTokens：分项计法不变，只有权重换 CJK 感知 ----------

test("count_tokens：1000 中文字 ≥950（改前 ≈250）", () => {
  const r = estimateTokens({ messages: [{ role: "user", content: "汉".repeat(1000) }] });
  assert.ok(r.input_tokens >= 950, `实得 ${r.input_tokens}`);
});

test("count_tokens：1000 ASCII 落在 250~280（不因中文改动抬高英文）", () => {
  const r = estimateTokens({ messages: [{ role: "user", content: "a".repeat(1000) }] });
  assert.ok(r.input_tokens >= 250 && r.input_tokens <= 280, `实得 ${r.input_tokens}`);
});

test("count_tokens：空 body ≥1 且 input_tokens === count_tokens", () => {
  const r = estimateTokens({});
  assert.ok(Number.isInteger(r.count_tokens) && r.count_tokens >= 1);
  assert.equal(r.input_tokens, r.count_tokens);
});

test("count_tokens：tool_result 全文与 tools 定义仍计入", () => {
  const bare = estimateTokens({ messages: [{ role: "user", content: "1234" }] }).count_tokens;
  const withResult = estimateTokens({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x".repeat(400) }] }] }).count_tokens;
  assert.ok(withResult >= 100, `实得 ${withResult}`);
  const withTools = estimateTokens({ messages: [], tools: [{ name: "Read", input_schema: { properties: { p: { type: "string" } } } }] }).count_tokens;
  assert.ok(withTools > bare, "tools 定义必须计入");
});

test("count_tokens：图片按面值 2000", () => {
  const r = estimateTokens({ messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://e/x.png" } }] }] });
  assert.ok(r.count_tokens >= 2000);
});

// ---------- toAnthropicUsage：整条未报/全 0 → 兜底；有实数 → 原样 ----------

const FB = () => ({ input_tokens: 111, output_tokens: 22 });

test("无 usage → 兜底填 input/output，缓存字段保持 0", () => {
  assert.deepEqual(toAnthropicUsage(undefined, FB), { input_tokens: 111, output_tokens: 22, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
});

test("上游报实数 → 逐字段原样，兜底不参与", () => {
  assert.deepEqual(toAnthropicUsage({ prompt_tokens: 123, completion_tokens: 45 }, FB), { input_tokens: 123, output_tokens: 45, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
});

test("上游谎报全 0 → 视为未报走兜底", () => {
  const u = toAnthropicUsage({ prompt_tokens: 0, completion_tokens: 0 }, FB);
  assert.equal(u.input_tokens, 111);
  assert.equal(u.output_tokens, 22);
});

test("缓存读扣减纪律不被兜底破坏（translate.js:151 既有口径）", () => {
  const u = toAnthropicUsage({ prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } }, FB);
  assert.equal(u.input_tokens, 40);
});

// ---------- chatJsonToAnthropic / 流式 translator：estInput 注入 ----------

test("非流式：无 usage 时 input 取 estInput、output 由生成内容估出", () => {
  const calls = [];
  const m = chatJsonToAnthropic({ choices: [{ message: { content: "回复内容" } }] }, "m", { estInput: () => { calls.push(1); return 777; } });
  assert.equal(m.usage.input_tokens, 777);
  assert.ok(m.usage.output_tokens > 0, `实得 ${m.usage.output_tokens}`);
  assert.equal(calls.length, 1);
});

test("非流式：上游报 usage 时数值原样且 estInput 不被调用", () => {
  let calls = 0;
  const m = chatJsonToAnthropic({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }, "m", { estInput: () => { calls++; return 777; } });
  assert.equal(m.usage.input_tokens, 5);
  assert.equal(m.usage.output_tokens, 2);
  assert.equal(calls, 0);
});

test("流式：message_start 的 input_tokens 来自 estInput 且每请求只算一次（memoize）", () => {
  let calls = 0;
  const t = createAnthropicChunkTranslator("m", { estInput: () => { calls++; return 888; } });
  const start = t.begin()[0].message;
  assert.equal(start.usage.input_tokens, 888);
  t.push(`data: ${JSON.stringify({ choices: [{ delta: { content: "回复内容" } }] })}\n\n`);
  const md = t.end().find((e) => e.type === "message_delta");
  assert.ok(md, "收场事件里必须有 message_delta");
  assert.equal(md.usage.input_tokens, 888, "末帧 input 与首帧同源");
  assert.equal(md.usage.output_tokens, estimateTextTokens("回复内容"), "output 为生成侧累计");
  assert.equal(calls, 1, "estInput 必须被 memoize");
});

test("流式：上游报 usage 时 message_delta 以实测为准，估算只在首帧", () => {
  let calls = 0;
  const t = createAnthropicChunkTranslator("m", { estInput: () => { calls++; return 888; } });
  t.begin();
  t.push(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }], usage: { prompt_tokens: 12, completion_tokens: 3 } })}\n\n`);
  const md = t.end().find((e) => e.type === "message_delta");
  assert.equal(md.usage.input_tokens, 12);
  assert.equal(md.usage.output_tokens, 3);
  assert.equal(calls, 1);
});

test("流式：thinking 与 tool 参数增量计入生成侧 output", () => {
  const t = createAnthropicChunkTranslator("m", { thinking: true, estInput: () => 1 });
  t.begin();
  t.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "思考" } }] })}\n\n`);
  t.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: "{\"a\":" } }] } }] })}\n\n`);
  const md = t.end().find((e) => e.type === "message_delta");
  assert.equal(md.usage.output_tokens, estimateTextTokens("思考{\"a\":"), "合并计一次：逐段各套公式会把参照实现的 +1 下限乘上段数");
});

test("cache 非零而 prompt/output 全 0 → 视为已报、不兜底（防 input+cache_read 翻倍，评审 P2）", () => {
  const u = toAnthropicUsage({ prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 60 } }, FB);
  assert.deepEqual(u, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 60, cache_creation_input_tokens: 0 });
});

test("count_tokens 多块消息聚成一段计（块数不再放大「非空至少 1」下限）", () => {
  const blocks = Array.from({ length: 40 }, (_, i) => ({ type: "text", text: "字" }));
  const many = estimateTokens({ messages: [{ role: "user", content: blocks }] }).count_tokens;
  const one = estimateTokens({ messages: [{ role: "user", content: "字".repeat(40) }] }).count_tokens;
  assert.ok(Math.abs(many - one) <= 1, `多块 ${many} vs 单段 ${one}：逐块套公式会把下限乘 40 倍`);
});
