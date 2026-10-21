// /v1/messages 请求侧「对齐 cc-switch」新行为的回归：形状取稳（计费头/schema/o 系列/stream_options）、
// 字节稳定（canonical JSON）、工具结果媒体外移。
// 依据：cc-switch src-tauri/src/proxy/{providers/transform.rs, json_canonical.rs, tool_media.rs}
import test from "node:test";
import assert from "node:assert/strict";
import { messagesToChatBody } from "../src/anthropic/translate.js";
import { stripLeadingBillingHeader, cleanToolSchema, isOpenAiOSeries } from "../src/anthropic/request-shape.js";
import { canonicalJson, canonicalizeValue } from "../src/anthropic/canonical-json.js";
import { MEDIA_MOVED_MARKER } from "../src/anthropic/tool-media.js";

test("request-shape：剥 system 开头计费头（只剥首行、含其后的一个空行）", () => {
  const hdr = "x-anthropic-billing-header: cc_version=2.1.119; cc_entrypoint=sdk-cli; cch=a7754;";
  assert.equal(stripLeadingBillingHeader(`${hdr}\n\nYou are Claude Code.`), "You are Claude Code.");
  assert.equal(stripLeadingBillingHeader(`${hdr}\r\n\r\nrest`), "rest");
  assert.equal(stripLeadingBillingHeader(hdr), ""); // 整段就这一行（无换行）→ 空
  assert.equal(stripLeadingBillingHeader(`前缀\n${hdr}\nbody`), `前缀\n${hdr}\nbody`); // 不在开头：原样
  assert.equal(stripLeadingBillingHeader("普通 system"), "普通 system");
});

test("request-shape：clean_schema 补根 type/properties、删 format:uri、不改入参", () => {
  assert.deepEqual(cleanToolSchema({}), { type: "object", properties: {}, required: [] });
  const src = { properties: { u: { type: "string", format: "uri" } }, items: { format: "uri", type: "string" } };
  const out = cleanToolSchema(src);
  assert.deepEqual(out, { type: "object", properties: { u: { type: "string" } }, items: { type: "string" }, required: [] });
  assert.deepEqual(src, { properties: { u: { type: "string", format: "uri" } }, items: { format: "uri", type: "string" } }); // 入参未被改
});

// agentrouter 实测 2026-10-21：带 $schema 的空参数工具（Claude Code 内建 CronList 等）被判
// `null is not of type "array"`（400）。$schema 是 JSON-Schema 元字段，非 OpenAI parameters 字段，逐层删。
test("request-shape：clean_schema 逐层删 $schema 元字段", () => {
  const src = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      nested: { $schema: "http://draft-07", type: "object", properties: { x: { type: "number" } } },
      list: { type: "array", items: { $schema: "x", type: "string" } },
    },
  };
  const out = cleanToolSchema(src);
  assert.equal("$schema" in out, false, "根 $schema 应删");
  assert.equal("$schema" in out.properties.nested, false, "嵌套层 $schema 应删");
  assert.equal("$schema" in out.properties.list.items, false, "items $schema 应删");
  assert.equal("$schema" in src, true, "入参不得被污染");
    // 空参数工具（CronList 形状）：删 $schema + 补 required:[] 后剩合法 OpenAI parameters
  const empty = cleanToolSchema({ $schema: "https://json-schema.org/draft/2020-12/schema", additionalProperties: false, properties: {}, type: "object" });
  assert.deepEqual(empty, { additionalProperties: false, properties: {}, type: "object", required: [] });
  // 已有 required 的工具不得被塞 []
  const withReq = cleanToolSchema({ type: "object", properties: { path: { type: "string" } }, required: ["path"] });
  assert.deepEqual(withReq.required, ["path"]);
});

test("request-shape：o 系列判定（带供应商前缀也认，末段匹配）", () => {
  for (const id of ["o1", "o3", "o4-mini", "openai/o3", "azure/o1-preview"]) assert.equal(isOpenAiOSeries(id), true, id);
  for (const id of ["gpt-4o", "o1x", "claude/o3x", "", "o"]) assert.equal(isOpenAiOSeries(id), false, id);
});

test("canonical-json：键序排列 + 紧凑输出 + 数组保序", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
  assert.equal(canonicalJson("带\"引号\""), JSON.stringify('带"引号"'));
  assert.equal(canonicalJson(1.5), "1.5");
  assert.equal(canonicalJson(null), "null");
  assert.deepEqual(canonicalizeValue({ b: { z: 1, y: 2 }, a: 3 }), { a: 3, b: { y: 2, z: 1 } });
});

test("messagesToChatBody：system 剥计费头 + 块间用 \\n", () => {
  const b = messagesToChatBody({
    model: "m",
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=1; cch=rotating;\n\n静态前缀", cache_control: { type: "ephemeral" } },
      { type: "text", text: "动态尾巴" },
    ],
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(b.messages[0].content, "静态前缀\n动态尾巴");
  assert.equal("cache_control" in b.messages[0], false);
});

test("messagesToChatBody：tools 过滤 BatchTool、description 缺省不写、schema 过 clean", () => {
  const b = messagesToChatBody({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      { name: "keep", input_schema: {} },
      { name: "nodesc", input_schema: { type: "object", properties: { a: { type: "string" } } } },
      { name: "batched", type: "BatchTool", input_schema: { type: "object" } },
      { name: "urischema", description: "有描述", input_schema: { type: "object", properties: { p: { type: "string", format: "uri" } } } },
    ],
  });
  assert.deepEqual(b.tools.map((t) => t.function.name), ["keep", "nodesc", "urischema"]);
  assert.deepEqual(b.tools[0].function.parameters, { type: "object", properties: {}, required: [] });
  assert.equal("description" in b.tools[0].function, false);
  assert.equal("description" in b.tools[1].function, false);
  assert.equal(b.tools[2].function.description, "有描述");
  assert.deepEqual(b.tools[2].function.parameters.properties.p, { type: "string" });
});

test("messagesToChatBody：o 系列 max_tokens → max_completion_tokens；stream_options merge 不覆盖", () => {
  const o = messagesToChatBody({ model: "openai/o3", messages: [{ role: "user", content: "hi" }], max_tokens: 1000 });
  assert.equal(o.max_completion_tokens, 1000);
  assert.equal("max_tokens" in o, false);
  const g = messagesToChatBody({ model: "gpt-4.1", messages: [{ role: "user", content: "hi" }], max_tokens: 1000 });
  assert.equal(g.max_tokens, 1000);
  const s = messagesToChatBody({ model: "m", stream: true, stream_options: { foo: 1 }, messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(s.stream_options, { foo: 1, include_usage: true });
});

test("messagesToChatBody：tool_use arguments 走 canonical（键序稳定）", () => {
  const b = messagesToChatBody({
    model: "m",
    messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { z: 1, a: { b: 2, a: 1 } } }] }],
  });
  assert.equal(b.messages[0].tool_calls[0].function.arguments, '{"a":{"a":1,"b":2},"z":1}');
});

test("messagesToChatBody：tool_result 里的图外移成一条 user 消息（不静默丢图）", () => {
  const b = messagesToChatBody({
    model: "m",
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Shot", input: {} }] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "t1", content: [
          { type: "text", text: "截图如下" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
        ] },
        { type: "text", text: "继续" },
      ] },
    ],
  });
  const roles = b.messages.map((m) => m.role);
  assert.deepEqual(roles, ["assistant", "tool", "user", "user"]);
  // tool 消息只能带文本：媒体位置换成标记
  assert.equal(typeof b.messages[1].content, "string");
  assert.ok(b.messages[1].content.includes(MEDIA_MOVED_MARKER));
  // 媒体轮：先一行出处标注，再图片分片
  const mediaTurn = b.messages[2];
  assert.equal(mediaTurn.content[0].text, "[mslxdff: media output of tool call t1]");
  assert.deepEqual(mediaTurn.content[1], { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } });
  // 同轮普通内容排在媒体轮之后
  assert.equal(b.messages[3].content, "继续");
});

test("messagesToChatBody：出站体键序恒定（前缀缓存字节稳定）", () => {
  const b = messagesToChatBody({ model: "m", stream: true, temperature: 0.2, max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(Object.keys(b), [...Object.keys(b)].sort());
});

test("messagesToChatBody：空会话仍抛错（绝不伪造一句 hi 打上游）", () => {
  assert.throws(() => messagesToChatBody({ model: "m", system: "only system", messages: [] }), /缺少用户消息/);
});
