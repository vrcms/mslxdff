// traework payload 改写规则单测：stream/function/model+config_name/content/tool_choice/tools。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { prepareBody, normalizeToolChoice, normalizeTools } from "../src/providers/traework/payload.js";

describe("traework payload", () => {
  test("stream 强制 true + function 固定 + model 双写", () => {
    const out = prepareBody({ model: "glm-5.2", messages: [], stream: false });
    assert.equal(out.stream, true);
    assert.equal(out.function, "solo_work_lite");
    assert.equal(out.model, "glm-5.2");
    assert.equal(out.config_name, "glm-5.2");
  });
  test("空 model 回退 glm-5.2", () => {
    const out = prepareBody({ messages: [] });
    assert.equal(out.model, "glm-5.2");
    assert.equal(out.config_name, "glm-5.2");
  });
  test("content 字符串→[{type:text}]；数组透传；缺 content 跳过", () => {
    const out = prepareBody({ model: "glm-5.2", messages: [
      { role: "user", content: "hi" },
      { role: "user", content: [{ type: "text", text: "x" }] },
      { role: "assistant", tool_calls: [{ id: "1", type: "function", function: { name: "f", arguments: "{}" } }] },
    ] });
    assert.deepEqual(out.messages[0].content, [{ type: "text", text: "hi" }]);
    assert.deepEqual(out.messages[1].content, [{ type: "text", text: "x" }]);
    assert.ok(!("content" in out.messages[2]));
  });
  test("assistant function→function_call；无 name 剔除；全空删 tool_calls", () => {
    const out = prepareBody({ model: "m", messages: [
      { role: "assistant", content: "t", tool_calls: [
        { id: "1", type: "function", function: { name: "run", arguments: "{}" } },
        { id: "2", type: "function", function: { arguments: "{}" } },
      ] },
      { role: "assistant", content: "t", tool_calls: [{ id: "3", type: "function", function: { arguments: "{}" } }] },
    ] });
    assert.deepEqual(out.messages[0].tool_calls, [{ id: "1", type: "function", function_call: { name: "run", arguments: "{}" } }]);
    assert.ok(!("tool_calls" in out.messages[1]));
  });
  test("tool_choice: none/{type:none} 删 tool_choice+tools；auto/required→字符串；function→name；其他删", () => {
    let o = { tool_choice: "none", tools: [{ function: { name: "a" } }] };
    normalizeToolChoice(o);
    assert.ok(!("tool_choice" in o) && !("tools" in o));
    o = { tool_choice: { type: "none" }, tools: [{ function: { name: "a" } }] };
    normalizeToolChoice(o);
    assert.ok(!("tool_choice" in o) && !("tools" in o));
    o = { tool_choice: { type: "auto" } };
    normalizeToolChoice(o);
    assert.equal(o.tool_choice, "auto");
    o = { tool_choice: { type: "required" } };
    normalizeToolChoice(o);
    assert.equal(o.tool_choice, "required");
    o = { tool_choice: { type: "function", function: { name: "run" } } };
    normalizeToolChoice(o);
    assert.equal(o.tool_choice, "run");
    o = { tool_choice: { type: "function" } };
    normalizeToolChoice(o);
    assert.equal(o.tool_choice, "auto");
    o = { tool_choice: { type: "weird" } };
    normalizeToolChoice(o);
    assert.ok(!("tool_choice" in o));
    o = { tool_choice: 42 };
    normalizeToolChoice(o);
    assert.ok(!("tool_choice" in o));
  });
  test("tools：缺 function 剔除；parameters 对象→JSON 字符串；全空删 tools", () => {
    const o = { tools: [
      { type: "function", function: { name: "a", parameters: { type: "object", properties: {} } } },
      { type: "function" },
      "junk",
    ] };
    normalizeTools(o);
    assert.equal(o.tools.length, 1);
    assert.equal(typeof o.tools[0].function.parameters, "string");
    const empty = { tools: [{ type: "function" }] };
    normalizeTools(empty);
    assert.ok(!("tools" in empty));
  });
  test("非法 JSON 字符串原样返回", () => {
    assert.equal(prepareBody("not-json{"), "not-json{");
    assert.equal(prepareBody(""), "");
  });
});
