// traework SSE 单测：output/done/error 解析 + 聚合 + 流转换。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseSOLOLine, createSseState, scanLine,
  aggregateToCompletion, convertToOpenAIChunks, normalizeStreamToolCalls,
} from "../src/providers/traework/sse.js";
import { SOLOStreamError } from "../src/providers/traework/errors.js";
import { mapModel } from "../src/providers/traework/models.js";

function feed(text) {
  const st = createSseState();
  const evs = [];
  for (const line of String(text).split("\n")) {
    const ev = scanLine(st, line.replace(/\r$/, ""));
    if (ev) evs.push(ev);
  }
  return evs;
}

const SOLO_SAMPLE = [
  "event: output",
  'data: {"response":"hello ","reasoning_content":"think1","tool_calls":null}',
  "",
  "event: output",
  'data: {"response":"world","reasoning_content":"think2","tool_calls":[{"index":0,"id":"c1","type":"function","function_call":{"name":"run","arguments":"{\\"a\\""}}]}',
  "",
  "event: output",
  'data: {"response":"","reasoning_content":"","tool_calls":[{"index":0,"function_call":{"arguments":"}:1}"},"namespace":"x","partial_arguments":"y"}]}',
  "",
  "event: token_usage",
  'data: {"prompt_tokens":21,"completion_tokens":142,"total_tokens":163}',
  "",
  "event: done",
  'data: {"finish_reason":"stop"}',
  "",
].join("\n");

describe("traework sse", () => {
  test("parseSOLOLine：output/done/error/token_usage", () => {
    const o = parseSOLOLine("output", '{"response":"a","reasoning_content":"b","tool_calls":null}');
    assert.equal(o.response, "a");
    assert.equal(o.reasoning, "b");
    const d = parseSOLOLine("done", '{"finish_reason":"tool_calls"}');
    assert.equal(d.finishReason, "tool_calls");
    const e = parseSOLOLine("error", '{"code":1005,"message":"plan"}');
    assert.equal(e.errorCode, 1005);
    assert.equal(e.errorMessage, "plan");
    const u = parseSOLOLine("token_usage", '{"prompt_tokens":1}');
    assert.deepEqual(u.usage, { prompt_tokens: 1 });
  });
  test("scanLine：注释忽略；空行触发事件", () => {
    const st = createSseState();
    assert.equal(scanLine(st, ": keep-alive"), null);
    assert.equal(scanLine(st, "event: done"), null);
    assert.equal(scanLine(st, 'data: {"finish_reason":"stop"}'), null);
    const ev = scanLine(st, "");
    assert.equal(ev.event, "done");
    assert.equal(ev.finishReason, "stop");
  });
  test("aggregateToCompletion：content/reasoning 拼接 + tool_calls 按 index 合并 + usage", () => {
    const out = aggregateToCompletion(SOLO_SAMPLE, { model: "glm-5.2" });
    assert.equal(out.object, "chat.completion");
    assert.equal(out.choices[0].message.content, "hello world");
    assert.equal(out.choices[0].message.reasoning_content, "think1think2");
    assert.equal(out.choices[0].finish_reason, "stop");
    assert.deepEqual(out.usage, { prompt_tokens: 21, completion_tokens: 142, total_tokens: 163 });
    const tc = out.choices[0].message.tool_calls;
    assert.equal(tc.length, 1);
    assert.equal(tc[0].function.name, "run");
    assert.equal(tc[0].function.arguments, '{"a"}:1}');
    assert.ok(!("namespace" in tc[0].function) && !("partial_arguments" in tc[0].function));
  });
  test("aggregateToCompletion：error 事件抛 SOLOStreamError", () => {
    const bad = ['event: error', 'data: {"code":1005,"message":"plan"}', ""].join("\n");
    assert.throws(() => aggregateToCompletion(bad), (e) => e instanceof SOLOStreamError && e.code === 1005);
  });
  test("convertToOpenAIChunks：delta + finish chunk + [DONE]；无 done 也兜底", () => {
    const sse = convertToOpenAIChunks(SOLO_SAMPLE, { model: "glm-5.2", chatId: "c1", created: 1 });
    assert.ok(sse.includes('"content":"hello "'));
    assert.ok(sse.includes('"reasoning_content":"think1"'));
    assert.ok(sse.includes('"finish_reason":"stop"'));
    assert.ok(sse.includes('"prompt_tokens":21'));
    assert.ok(sse.trimEnd().endsWith("data: [DONE]"));
    const noDone = convertToOpenAIChunks('event: output\ndata: {"response":"hi"}\n\n', { chatId: "c2", created: 1 });
    assert.ok(noDone.trimEnd().endsWith("data: [DONE]"));
  });
  test("convertToOpenAIChunks：error 事件注入 error 帧 + [DONE]", () => {
    const sse = convertToOpenAIChunks('event: error\ndata: {"code":1005,"message":"plan"}\n\n', { chatId: "c3", created: 1 });
    assert.ok(sse.includes("event: error"));
    assert.ok(sse.includes("data: [DONE]"));
  });
  test("normalizeStreamToolCalls：function_call→function 并清理专属字段", () => {
    const out = normalizeStreamToolCalls([{ index: 0, function_call: { name: "f", arguments: "{}", namespace: "x", partial_arguments: "y" } }]);
    assert.equal(out[0].function.name, "f");
    assert.ok(!("function_call" in out[0]));
    assert.ok(!("namespace" in out[0].function));
  });
  test("mapModel：空/auto→默认；去 __ 后缀；下划线宽松匹配；未知 400", () => {
    const known = ["glm-5.2", "DeepSeek-V4-Pro"];
    assert.equal(mapModel("", known).configName, "glm-5.2");
    assert.equal(mapModel("auto", known).configName, "glm-5.2");
    assert.equal(mapModel("glm-5.2__dev", known).configName, "glm-5.2");
    assert.equal(mapModel("deepseek_v4_pro", known).configName, "DeepSeek-V4-Pro");
    assert.throws(() => mapModel("nope-x", known), (e) => e.status === 400);
  });
});
