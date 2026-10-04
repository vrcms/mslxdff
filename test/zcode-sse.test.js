// zcode Anthropic SSE → OpenAI chunk 转换单测 — TDD 先行。
import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicToOpenAiStream, aggregateAnthropicToOpenAi } from "../src/providers/zcode/sse.js";

const evt = (type, obj) => `event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`;

const TEXT_SSE = [
  evt("message_start", { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 7 } } }),
  evt("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  evt("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } }),
  evt("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "世界" } }),
  evt("content_block_stop", { type: "content_block_stop", index: 0 }),
  evt("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }),
  evt("message_stop", { type: "message_stop" }),
].join("");

const TOOL_SSE = [
  evt("message_start", { type: "message_start", message: { id: "msg_2", usage: { input_tokens: 9 } } }),
  evt("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather" } }),
  evt("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city":' } }),
  evt("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"SH"}' } }),
  evt("content_block_stop", { type: "content_block_stop", index: 0 }),
  evt("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } }),
  evt("message_stop", { type: "message_stop" }),
].join("");

function streamFromTexts(texts) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const t of texts) controller.enqueue(encoder.encode(t));
      controller.close();
    },
  });
}

async function readStreamText(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

test("sse: 流式 text_delta → OpenAI chunk 序列 + [DONE] + usage", async () => {
  const stream = anthropicToOpenAiStream(streamFromTexts([TEXT_SSE.slice(0, 60), TEXT_SSE.slice(60)]), { model: "GLM-5.3-Flash" });
  const text = await readStreamText(stream);
  const lines = text.split("\n").filter((l) => l.startsWith("data: "));
  assert.ok(lines.length >= 4, "至少 role/两条文本/结束/DONE");
  assert.ok(text.trimEnd().endsWith("[DONE]"), "以 [DONE] 收尾");
  const payloads = text.split("\n").filter((l) => l.startsWith("data: ")).filter((l) => !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(6)));
  assert.equal(payloads[0].choices[0].delta.role, "assistant");
  assert.equal(payloads[1].choices[0].delta.content, "你好", "首条文本增量");
  assert.equal(payloads[2].choices[0].delta.content, "世界");
  const last = payloads[payloads.length - 1];
  assert.equal(last.choices[0].finish_reason, "stop", "end_turn → stop");
  assert.equal(last.usage.prompt_tokens, 7);
  assert.equal(last.usage.completion_tokens, 3);
  assert.ok(payloads[1].id && payloads[1].object === "chat.completion.chunk");
});

test("sse: tool_use 流式增量 → tool_calls delta（含 arguments 分片）", async () => {
  const stream = anthropicToOpenAiStream(streamFromTexts([TOOL_SSE]), { model: "GLM-5.3" });
  const text = await readStreamText(stream);
  const payloads = text.split("\n").filter((l) => l.startsWith("data: “") || l.startsWith("data: ")).filter((l) => !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(6)));
  const first = payloads.find((p) => p.choices[0].delta.tool_calls);
  assert.equal(first.choices[0].delta.tool_calls[0].function.name, "get_weather");
  assert.equal(first.choices[0].delta.tool_calls[0].id, "toolu_1");
  const argChunks = payloads
    .flatMap((p) => p.choices[0].delta.tool_calls || [])
    .map((tc) => tc.function?.arguments || "")
    .join("");
  assert.equal(argChunks, '{"city":"SH"}', "arguments 分片拼接完整");
  const last = payloads[payloads.length - 1];
  assert.equal(last.choices[0].finish_reason, "tool_calls");
});

test("sse: 非流式聚合 → OpenAI JSON（content/usage/finish_reason）", async () => {
  const out = await aggregateAnthropicToOpenAi(TEXT_SSE, { model: "GLM-5.3-Flash" });
  assert.equal(out.error, null);
  assert.equal(out.openAi.choices[0].message.content, "你好世界");
  assert.equal(out.openAi.choices[0].finish_reason, "stop");
  assert.equal(out.openAi.usage.prompt_tokens, 7);
  assert.equal(out.openAi.usage.completion_tokens, 3);
  assert.equal(out.openAi.usage.total_tokens, 10);
});

test("sse: 非流式聚合识别流内 error 事件", async () => {
  const errSse = evt("error", { type: "error", error: { type: "overloaded_error", message: "busy" } });
  const out = await aggregateAnthropicToOpenAi(errSse, { model: "GLM-5.2" });
  assert.ok(out.error, "错误被识别");
  assert.match(out.error.message, /busy/);
});

test("sse: thinking_delta → reasoning_content 增量 + 聚合回填 signature（跨轮必需）", async () => {
  const THINK_SSE = [
    evt("message_start", { type: "message_start", message: { id: "m3", usage: { input_tokens: 2 } } }),
    evt("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "sig-abc" } }),
    evt("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "先想" } }),
    evt("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "一想" } }),
    evt("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "答" } }),
    evt("message_stop", { type: "message_stop" }),
  ].join("");
  // 流式：thinking 以 reasoning_content 增量下发（opencode 渲染 Thought）
  const stream = anthropicToOpenAiStream(streamFromTexts([THINK_SSE]), { model: "GLM-5.3-Flash" });
  const text = await readStreamText(stream);
  const payloads = text.split("\n").filter((l) => l.startsWith("data: ")).filter((l) => !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(6)));
  const rc = payloads.flatMap((p) => [p.choices[0].delta.reasoning_content].filter(Boolean)).join("");
  assert.equal(rc, "先想一想", "thinking 增量逐字透出");
  // 聚合：message 带 reasoning_content + signature（上游跨轮要求原样回传）
  const out = await aggregateAnthropicToOpenAi(THINK_SSE, { model: "GLM-5.3-Flash" });
  assert.equal(out.error, null);
  assert.equal(out.openAi.choices[0].message.reasoning_content, "先想一想");
  assert.equal(out.openAi.choices[0].message.reasoning_content_signature, "sig-abc");
});
