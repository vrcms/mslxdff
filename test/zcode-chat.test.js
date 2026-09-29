// zcode chat 转发单测（请求转换 / 错误冷却 / 工厂收口 / registry 注册）— TDD 先行。
import { test } from "node:test";
import assert from "node:assert/strict";

import { toAnthropicRequest, forwardZcodeChat } from "../src/providers/zcode/chat.js";
import { createZcodeProvider } from "../src/providers/zcode/index.js";
import { getCustomProviderFactory } from "../src/providers/registry.js";

const evt = (type, obj) => `event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`;
const OK_SSE = [
  evt("message_start", { type: "message_start", message: { id: "m1", usage: { input_tokens: 5 } } }),
  evt("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  evt("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
  evt("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
  evt("message_stop", { type: "message_stop" }),
].join("");
const sseResponse = (text = OK_SSE) => new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } });
const bizFail = (code, status = 400) => new Response(JSON.stringify({ code, msg: `biz-${code}` }), { status, headers: { "Content-Type": "application/json" } });

test("chat: 纯文本请求转换（canonical 化 + 上游恒流式 + 参数透传）", () => {
  const out = toAnthropicRequest({ model: "zcode/glm-5.3-flash", messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }], stream: false, temperature: 0.5, max_tokens: 128 });
  assert.equal(out.model, "GLM-5.3-Flash");
  assert.equal(out.stream, true, "上游恒流式（非流式由本仓聚合）");
  assert.equal(out.system, "sys");
  assert.deepEqual(out.messages, [{ role: "user", content: "hi" }]);
  assert.equal(out.max_tokens, 128);
  assert.equal(out.temperature, 0.5);
});

test("chat: system 数组 / tool_calls 历史 / tool 结果映射", () => {
  const out = toAnthropicRequest({
    model: "GLM-5.2",
    messages: [
      { role: "system", content: [{ type: "text", text: "S1" }] },
      { role: "user", content: "q" },
      { role: "assistant", content: "a", tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: '{"x":1}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "42" },
    ],
  });
  assert.equal(out.system, "S1");
  const blocks = out.messages[1].content;
  assert.ok(Array.isArray(blocks), "assistant 历史带 tool_calls → 内容为块数组");
  const tu = blocks.find((b) => b.type === "tool_use");
  assert.ok(tu, "含 tool_use 块（文本块在前，与上游回显顺序一致）");
  assert.equal(blocks[0].type, "text");
  assert.equal(tu.id, "call_1");
  assert.equal(tu.name, "f");
  assert.deepEqual(tu.input, { x: 1 });
  assert.equal(out.messages[2].content[0].type, "tool_result");
  assert.equal(out.messages[2].content[0].tool_use_id, "call_1");
});

test("chat: tools / tool_choice 映射", () => {
  const out = toAnthropicRequest({ model: "GLM-5.3", messages: [{ role: "user", content: "x" }], tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }], tool_choice: "required" });
  assert.equal(out.tools[0].name, "f");
  assert.equal(out.tools[0].description, "d");
  assert.deepEqual(out.tools[0].input_schema, { type: "object" });
  assert.deepEqual(out.tool_choice, { type: "any" });
  const out2 = toAnthropicRequest({ model: "GLM-5.3", messages: [], tool_choice: { type: "function", function: { name: "g" } } });
  assert.deepEqual(out2.tool_choice, { type: "tool", name: "g" });
  const out3 = toAnthropicRequest({ model: "GLM-5.3", messages: [], tool_choice: "auto" });
  assert.deepEqual(out3.tool_choice, { type: "auto" });
});

test("chat: 缺 max_tokens 补默认 4096", () => {
  assert.equal(toAnthropicRequest({ model: "m", messages: [] }).max_tokens, 4096);
  assert.equal(toAnthropicRequest({ model: "m", messages: [], max_completion_tokens: 64 }).max_tokens, 64);
});

test("chat: 401/1006 → 401 重登指引 + kind=auth 标记", async () => {
  const res = await forwardZcodeChat({ body: { model: "zcode/GLM-5.2", messages: [] }, token: "tok", fetchImpl: async () => bizFail(1006, 401) });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("x-mslxdff-zcode-kind"), "auth");
  const j = await res.json();
  assert.match(j.error.message, /-provider zcode login/);
});

test("chat: 1005 → 429 quota_exhausted；3007 → 403 不冷却；限流 → 429 rate_limit", async () => {
  const quota = await forwardZcodeChat({ body: { model: "zcode/GLM-5.2", messages: [] }, token: "tok", fetchImpl: async () => bizFail(1005, 200) });
  assert.equal(quota.status, 429);
  assert.equal(quota.headers.get("x-mslxdff-zcode-kind"), "quota");
  assert.match((await quota.json()).error.type, /quota_exhausted/);

  const sec = await forwardZcodeChat({ body: { model: "zcode/GLM-5.2", messages: [] }, token: "tok", fetchImpl: async () => bizFail(3007, 403) });
  assert.equal(sec.status, 403);
  assert.equal(sec.headers.get("x-mslxdff-zcode-kind"), "security");
  assert.match((await sec.json()).error.message, /3007|安全/);

  const rl = await forwardZcodeChat({ body: { model: "zcode/GLM-5.2", messages: [] }, token: "tok", fetchImpl: async () => bizFail(3002, 429) });
  assert.equal(rl.status, 429);
  assert.equal(rl.headers.get("x-mslxdff-zcode-kind"), "rate_limit");
});

test("chat: 流式成功 → 200 event-stream（OpenAI chunk + [DONE]）", async () => {
  const res = await forwardZcodeChat({ body: { model: "zcode/GLM-5.2", messages: [{ role: "user", content: "hi" }], stream: true }, token: "tok", fetchImpl: async () => sseResponse() });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  assert.equal(res.headers.get("x-mslxdff-zcode-kind"), null, "成功不带错误标记");
  const text = await res.text();
  assert.ok(text.includes('"content":"hi"'));
  assert.ok(text.trimEnd().endsWith("[DONE]"));
});

test("chat: 非流式成功 → 200 JSON（聚合）", async () => {
  const res = await forwardZcodeChat({ body: { model: "zcode/GLM-5.2", messages: [{ role: "user", content: "hi" }], stream: false }, token: "tok", fetchImpl: async () => sseResponse() });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.choices[0].message.content, "hi");
  assert.equal(j.usage.total_tokens, 7);
});

test("chat: 鉴权头带 Bearer + source headers 出站", async () => {
  let seen = null;
  await forwardZcodeChat({ body: { model: "zcode/GLM-5.2", messages: [] }, token: "tok-abc", deviceMid: "mid-9", fetchImpl: async (url, opts) => { seen = { url: String(url), headers: opts.headers }; return sseResponse(); } });
  assert.ok(seen.url.endsWith("/api/v1/zcode-plan/anthropic/v1/messages"));
  assert.equal(seen.headers.Authorization, "Bearer tok-abc");
  assert.equal(seen.headers["X-Device-Mid"], "mid-9");
  assert.equal(seen.headers["X-Title"], "Z Code@electron");
});

test("index: 未登录 → 401 + login 指引", async () => {
  const p = createZcodeProvider({ apiKeys: [] });
  const res = await p.chat({ model: "zcode/GLM-5.2", messages: [] });
  assert.equal(res.status, 401);
  assert.match((await res.json()).error.message, /login/);
});

test("index: 双 key 一坏一好 → 自动换号且坏号进冷却", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(opts.headers.Authorization);
    if (String(opts.headers.Authorization).includes("bad")) return bizFail(1006, 401);
    return sseResponse();
  };
  const p = createZcodeProvider({ apiKeys: ["bad.jwt.token", "good.jwt.token"], fetchImpl, cooldownMs: 60_000 });
  const res = await p.chat({ model: "zcode/GLM-5.2", messages: [{ role: "user", content: "hi" }], stream: false });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2, "先撞坏号再换好号");
  assert.ok(p.keyRing.isCooling("bad.jwt.token"), "坏号被冷却");
  assert.equal(p.keyRing.isCooling("good.jwt.token"), false);
});

test("index: 双 key 全 1005 → 429 quota_exhausted 话术 + 长冷却", async () => {
  const fetchImpl = async () => bizFail(1005, 200);
  const p = createZcodeProvider({ apiKeys: ["k1", "k2"], fetchImpl, quotaCooldownMs: 3_600_000 });
  const res = await p.chat({ model: "zcode/GLM-5.2", messages: [] });
  assert.equal(res.status, 429);
  const j = await res.json();
  assert.match(j.error.type, /quota_exhausted/);
  assert.match(j.error.message, /额度/);
  assert.ok(p.keyRing.isCooling("k1") && p.keyRing.isCooling("k2"), "长冷却生效");
});

test("index: 单 key 3007 → 403 直透不冷却（换号无意义）", async () => {
  const fetchImpl = async () => bizFail(3007, 403);
  const p = createZcodeProvider({ apiKeys: ["k1"], fetchImpl });
  const res = await p.chat({ model: "zcode/GLM-5.2", messages: [] });
  assert.equal(res.status, 403);
  assert.equal(p.keyRing.isCooling("k1"), false);
});

test("index: listModels 出目录（免费 4 模型，带前缀）", async () => {
  const p = createZcodeProvider({ apiKeys: ["k1"], fetchImpl: async () => sseResponse() });
  const list = await p.listModels();
  const ids = list.map((m) => m.id);
  assert.ok(ids.includes("zcode/GLM-5.3-Flash"));
  assert.ok(ids.includes("zcode/GLM-5.3"));
  assert.equal(list[0].price, "0.00");
});

test("index: chatWithKeys 用临时 key 发一次", async () => {
  const seen = [];
  const p = createZcodeProvider({ apiKeys: ["k1"], fetchImpl: async (url, opts) => { seen.push(opts.headers.Authorization); return sseResponse(); } });
  await p.chatWithKeys({ model: "zcode/GLM-5.2", messages: [], stream: false }, ["tmp-key"]);
  assert.equal(seen[0], "Bearer tmp-key");
});

test("registry: zcode 命中自定义工厂（id 与 baseUrl 双匹配）", async () => {
  const byId = await getCustomProviderFactory("zcode", "");
  assert.equal(typeof byId, "function");
  const byUrl = await getCustomProviderFactory("whatever", "https://zcode.z.ai/api/v1");
  assert.equal(typeof byUrl, "function");
  const miss = await getCustomProviderFactory("nope", "https://example.com");
  assert.equal(miss, null);
});
