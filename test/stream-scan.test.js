import { test } from "node:test";
import assert from "node:assert/strict";
import { preflightMs, scanSseChunk, scanNonStreamBody } from "../src/routes/stream-scan.js";

// 量测锚点：上报用的首字必须补上「上游尝试开始 → 转发层入口」这段等待
// （qoder 等 provider 会在这段里预读首帧，见 ADR-0036；不补就永远读成 0/1ms）
test("上报锚点偏移 = 转发入口时刻 − 本次上游尝试起点", () => {
  // 尝试 1000ms 起，转发层 13000ms 才拿到响应（上游排队 12 秒）→ 该补 12000ms
  assert.equal(preflightMs(13_000, 1_000), 12_000);
});

// 降级不得变成故障源：拿不到锚点就当没这段等待（等于修复前行为），不能算出 NaN
test("无锚点（未传/非有限）时偏移为 0，退化为修复前口径", () => {
  assert.equal(preflightMs(13_000, undefined), 0);
  assert.equal(preflightMs(13_000, null), 0);
  assert.equal(preflightMs(13_000, NaN), 0);
  assert.equal(preflightMs(13_000, "1000"), 0, "字符串时刻不可信，按无锚点处理");
});

// 混钟防线：若哪天把 Date.now() 当锚点传进来，差值会是巨大负数 → 必须 clamp 0，
// 绝不能让上报时长变成负值或假高值
test("锚点晚于转发入口（时钟源不一致）时偏移 clamp 到 0", () => {
  assert.equal(preflightMs(1_000, 13_000), 0);
  assert.equal(preflightMs(5, 1_777_000_000_000), 0, "Date.now 混进 performance.now 的实测形状");
});

// —— 思考内容必须被观测到（qoder 等上游不上报 reasoning_tokens，现网 1249 行全记 0）——
function blankDetail() {
  return { usage: null, chars: 0, reasoningChars: 0, toolCalls: 0, chatShaped: false, sawDone: false, sawFinishReason: null };
}
const dataLine = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

test("逐帧扫描分开统计正文与思考字符（usage 帧路径）", () => {
  const detail = blankDetail();
  const text = dataLine({ choices: [{ index: 0, delta: { reasoning_content: "R".repeat(40) } }] })
    + dataLine({ choices: [{ index: 0, delta: { content: "0123456789" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } });
  scanSseChunk(detail, text);
  assert.equal(detail.chars, 10, "chars 只算正文，思考不得混进来");
  assert.equal(detail.reasoningChars, 40, "思考字符必须单独累计");
});

test("无 usage 帧时走正则兜底，思考字符同样要记（reasoning_content）", () => {
  const detail = blankDetail();
  scanSseChunk(detail, dataLine({ choices: [{ index: 0, delta: { reasoning_content: "思".repeat(20) } }] }));
  assert.equal(detail.reasoningChars, 20);
  assert.equal(detail.chars, 0, "纯思考轮的正文计数保持 0（空转判定依赖它）");
});

test("另一种上游的 reasoning 字段名同样计入思考字符", () => {
  const detail = blankDetail();
  scanSseChunk(detail, dataLine({ choices: [{ index: 0, delta: { reasoning: "x".repeat(12) } }] }));
  assert.equal(detail.reasoningChars, 12);
});

test("非流式聚合体也记思考字符（qoder stream:false 出口在 message.reasoning_content）", () => {
  const detail = blankDetail();
  scanNonStreamBody(detail, { choices: [{ message: { content: "答案", reasoning_content: "T".repeat(36) } }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
  assert.equal(detail.chars, 2, "正文只算 content");
  assert.equal(detail.reasoningChars, 36);
});
