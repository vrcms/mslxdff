import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  toModelPrompt,
  toModelTools,
  toModelToolChoice,
  toModelParams,
  toProviderExtras,
} from "../src/upstream-engine/sdk/convert.js";

describe("toModelPrompt", () => {
  it("system/user 字符串消息映射为标准形状", () => {
    const p = toModelPrompt([
      { role: "system", content: "你是助手" },
      { role: "user", content: "你好" },
    ]);
    assert.deepEqual(p, [
      { role: "system", content: "你是助手" },
      { role: "user", content: [{ type: "text", text: "你好" }] },
    ]);
  });

  it("user 数组内容：text + image_url 映射（图片转 file part）", () => {
    const p = toModelPrompt([
      {
        role: "user",
        content: [
          { type: "text", text: "看图" },
          { type: "image_url", image_url: { url: "https://example.com/a.png" } },
        ],
      },
    ]);
    assert.equal(p[0].content.length, 2);
    assert.deepEqual(p[0].content[0], { type: "text", text: "看图" });
    assert.equal(p[0].content[1].type, "file");
    assert.equal(p[0].content[1].mediaType, "image/*");
    assert.equal(String(p[0].content[1].data), "https://example.com/a.png");
  });

  it("assistant：reasoning_content 保留（thinking 回传）+ tool_calls 解析为对象", () => {
    const p = toModelPrompt([
      {
        role: "assistant",
        content: "",
        reasoning_content: " ",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"北京"}' } },
        ],
      },
    ]);
    const parts = p[0].content;
    assert.ok(parts.some((x) => x.type === "reasoning" && x.text === " "), "reasoning part 保留占位");
    const tc = parts.find((x) => x.type === "tool-call");
    assert.equal(tc.toolCallId, "call_1");
    assert.equal(tc.toolName, "get_weather");
    assert.deepEqual(tc.input, { city: "北京" });
  });

  it("tool 消息映射为 tool-result(text)", () => {
    const p = toModelPrompt([
      { role: "tool", tool_call_id: "call_1", name: "get_weather", content: '{"temp":25}' },
    ]);
    assert.equal(p[0].role, "tool");
    assert.deepEqual(p[0].content[0], {
      type: "tool-result",
      toolCallId: "call_1",
      toolName: "get_weather",
      output: { type: "text", value: '{"temp":25}' },
    });
  });

  it("developer 角色降级为 system，未知/空消息跳过", () => {
    const p = toModelPrompt([{ role: "developer", content: "规则" }, null, { content: "无角色" }]);
    assert.equal(p.length, 1);
    assert.deepEqual(p[0], { role: "system", content: "规则" });
  });
});

describe("toModelTools / toModelToolChoice", () => {
  it("OpenAI function 工具 → AI SDK 工具形状", () => {
    const tools = toModelTools([
      { type: "function", function: { name: "get_weather", description: "查天气", parameters: { type: "object", properties: { city: { type: "string" } } } } },
    ]);
    assert.deepEqual(tools, [
      { type: "function", name: "get_weather", description: "查天气", inputSchema: { type: "object", properties: { city: { type: "string" } } } },
    ]);
    assert.equal(toModelTools([]), undefined);
    assert.equal(toModelTools(undefined), undefined);
  });

  it("tool_choice 映射：字符串与指定函数", () => {
    assert.deepEqual(toModelToolChoice("auto"), { type: "auto" });
    assert.deepEqual(toModelToolChoice("required"), { type: "required" });
    assert.deepEqual(toModelToolChoice("none"), { type: "none" });
    assert.deepEqual(toModelToolChoice({ type: "function", function: { name: "get_weather" } }), { type: "tool", toolName: "get_weather" });
    assert.equal(toModelToolChoice(undefined), undefined);
  });
});

describe("toModelParams / toProviderExtras", () => {
  it("标准参数映射 + reasoning_effort 走 openaiCompatible", () => {
    const p = toModelParams({
      model: "glm-5.3-flash",
      max_tokens: 128,
      temperature: 0.5,
      top_p: 0.9,
      stop: ["END"],
      seed: 7,
      reasoning_effort: "high",
      messages: [],
      stream: true,
    });
    assert.equal(p.maxOutputTokens, 128);
    assert.equal(p.temperature, 0.5);
    assert.equal(p.topP, 0.9);
    assert.deepEqual(p.stopSequences, ["END"]);
    assert.equal(p.seed, 7);
    assert.deepEqual(p.providerOptions.openaiCompatible, { reasoningEffort: "high" });
  });

  it("未映射字段经 providerOptions.workbuddy 原样兜底；stream/messages 不兜", () => {
    const extras = toProviderExtras({
      model: "m", messages: [], stream: true, stream_options: { include_usage: true }, parallel_tool_calls: false,
    });
    assert.deepEqual(extras, { stream_options: { include_usage: true }, parallel_tool_calls: false });
    const p = toModelParams({ model: "m", messages: [], stream_options: { include_usage: true } }, "workbuddy");
    assert.deepEqual(p.providerOptions.workbuddy, { stream_options: { include_usage: true } });
  });
});
