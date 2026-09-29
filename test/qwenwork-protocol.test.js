// qwenwork 单测：请求体组装 + 模型映射 + 解帧聚合。不碰网络。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBody, mapModel } from "../src/providers/qwenwork/payload.js";
import { unwrapFrame, cleanChunk, aggregate, creditsExhaustedText, isCreditsExhausted } from "../src/providers/qwenwork/sse.js";

test("mapModel: 别名收敛到 3 个 key，未知透传", () => {
  assert.equal(mapModel(""), "flash");
  assert.equal(mapModel("auto"), "flash");
  assert.equal(mapModel("lite"), "flash");
  assert.equal(mapModel("pro"), "pro");
  assert.equal(mapModel("advanced"), "pro");
  assert.equal(mapModel("qwen3.8-max-preview"), "qwen3.8-max-preview");
  assert.equal(mapModel("max"), "qwen3.8-max-preview");
  assert.equal(mapModel("weird-custom"), "weird-custom");
});

test("buildBody: 三 id 同值 + stream 恒真 + system 抽顶", () => {
  const b = JSON.parse(buildBody({ messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }] }, "flash"));
  assert.equal(b.request_id, b.request_set_id);
  assert.equal(b.request_id, b.chat_record_id);
  assert.equal(b.stream, true);
  assert.equal(b.system, "sys");
  assert.ok(b.messages.every((m) => m.role !== "system"));
  assert.equal(b.chat_context.text, "hi");
  assert.equal(b.chat_context.extra.originalContent, "hi");
  assert.equal(b.model_config.key, "flash");
  assert.equal(b.parameters.max_tokens, 32000);
});

test("buildBody: max_tokens 优先级 + tool_choice none 清空", () => {
  const b = JSON.parse(buildBody({ messages: [{ role: "user", content: "x" }], max_tokens: 100, tools: [{ type: "function" }], tool_choice: "none" }, "pro"));
  assert.equal(b.parameters.max_tokens, 100);
  assert.deepEqual(b.tools, []);
  const b2 = JSON.parse(buildBody({ messages: [{ role: "user", content: "x" }], max_completion_tokens: 55 }, "pro"));
  assert.equal(b2.parameters.max_tokens, 55);
});

test("unwrapFrame: 信封解出内层；裸 choices 透传；错误帧判错", () => {
  const inner = JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: "hi" } }] });
  const env = JSON.stringify({ headers: {}, body: inner, statusCodeValue: 200 });
  const r = unwrapFrame(env);
  assert.equal(r.ok, true);
  assert.equal(r.body, inner);
  const bare = JSON.stringify({ choices: [{ index: 0, delta: { content: "x" } }] });
  assert.equal(unwrapFrame(bare).ok, true);
  assert.equal(unwrapFrame("[DONE]").ok, false);
  assert.equal(unwrapFrame("{}").ok, false);
  const errEnv = JSON.stringify({ headers: {}, body: JSON.stringify({ code: "403", message: "nope" }), statusCodeValue: 403 });
  const e = unwrapFrame(errEnv);
  assert.equal(e.ok, false);
  assert.ok(e.error);
});

test("cleanChunk: 删空 delta 字段与 usage 噪音", () => {
  const t = JSON.stringify({ choices: [{ index: 0, delta: { content: "", tool_calls: [] } }] });
  assert.equal(cleanChunk(t), "");
  const u = JSON.stringify({ usage: { prompt_tokens: 1, raw_usage: {}, sub_usages: [] } });
  const cu = JSON.parse(cleanChunk(u));
  assert.ok(!("raw_usage" in cu.usage));
});

test("aggregate: 内容/reasoning/tool_calls 合并 + usage 摘出", () => {
  const chunks = [
    JSON.stringify({ id: "c9", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "He" } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: { content: "llo", reasoning_content: "think" } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "fn", arguments: "{}" } }] } }] }),
    JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
  ];
  const out = aggregate(chunks, "flash");
  assert.equal(out.choices[0].message.content, "Hello");
  assert.equal(out.choices[0].message.reasoning_content, "think");
  assert.equal(out.choices[0].message.tool_calls.length, 1);
  assert.equal(out.usage.total_tokens, 15);
});

test("额度判定: 402 恒真；429 看措辞；code 14018 命中", () => {
  assert.equal(isCreditsExhausted(402, "anything"), true);
  assert.equal(isCreditsExhausted(429, "credits exhausted"), true);
  assert.equal(isCreditsExhausted(429, "额度不足"), true);
  assert.equal(isCreditsExhausted(429, "random busy"), false);
  assert.equal(isCreditsExhausted(200, "credits exhausted"), false);
  assert.equal(creditsExhaustedText('{"code":14018}'), true);
});
