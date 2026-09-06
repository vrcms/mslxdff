import assert from "node:assert/strict";
import test from "node:test";

import { buildPrompt, mapModelToFlags, createDeepseekSseParser, buildUpstreamBody } from "../src/providers/deepseek/bridge.js";

test("buildPrompt: first user message has no tag", () => {
  assert.equal(buildPrompt([{ role: "user", content: "你好" }]), "你好");
});

test("buildPrompt: later user messages get User tag", () => {
  const out = buildPrompt([
    { role: "user", content: "一" },
    { role: "assistant", content: "答" },
    { role: "user", content: "二" },
  ]);
  assert.equal(out, "一<｜Assistant｜>答<｜end▁of▁sentence｜><｜User｜>二");
});

test("buildPrompt: system message first is bare, later system like user", () => {
  const out = buildPrompt([
    { role: "system", content: "规则" },
    { role: "user", content: "问题" },
  ]);
  assert.equal(out, "规则<｜User｜>问题");
});

test("buildPrompt: merges consecutive same-role messages with blank line", () => {
  const out = buildPrompt([
    { role: "user", content: "a" },
    { role: "user", content: "b" },
    { role: "user", content: "c" },
  ]);
  assert.equal(out, "a\n\nb\n\nc");
});

test("buildPrompt: array content extracts text parts", () => {
  const out = buildPrompt([
    { role: "user", content: [{ type: "text", text: "l1" }, { type: "image_url", image_url: { url: "x" } }, { type: "text", text: "l2" }] },
  ]);
  assert.equal(out, "l1\nl2");
});

test("buildPrompt: empty messages yields empty string", () => {
  assert.equal(buildPrompt([]), "");
});

test("buildPrompt: other roles pass through bare", () => {
  const out = buildPrompt([
    { role: "tool", content: "tool out" },
    { role: "user", content: "next" },
  ]);
  assert.equal(out, "tool out<｜User｜>next");
});

test("mapModelToFlags maps all six models + unknown fallback", () => {
  assert.deepEqual(mapModelToFlags("deepseek-chat"), { thinking: false, search: false, expert: false });
  assert.deepEqual(mapModelToFlags("deepseek-reasoner"), { thinking: true, search: false, expert: false });
  assert.deepEqual(mapModelToFlags("deepseek-chat-search"), { thinking: false, search: true, expert: false });
  assert.deepEqual(mapModelToFlags("deepseek-reasoner-search"), { thinking: true, search: true, expert: false });
  assert.deepEqual(mapModelToFlags("deepseek-chat-expert"), { thinking: false, search: false, expert: true });
  assert.deepEqual(mapModelToFlags("deepseek-reasoner-expert"), { thinking: true, search: false, expert: true });
  assert.deepEqual(mapModelToFlags("whatever"), { thinking: false, search: false, expert: false });
});

test("createDeepseekSseParser: v2 protocol real capture (snapshot + APPEND + bare v + FINISHED)", () => {
  const parse = createDeepseekSseParser();
  const sse = [
    'event: ready',
    'data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}',
    '',
    '',
    'event: update_session',
    'data: {"updated_at":1788608314.9927268}',
    '',
    '',
    'data: {"v":{"response":{"message_id":2,"role":"ASSISTANT","status":"WIP","fragments":[{"id":2,"type":"RESPONSE","content":"《","references":[],"stage_id":1}]}}}',
    '',
    '',
    'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"秋"}',
    '',
    '',
    'data: {"v":"日"}',
    '',
    '',
    'data: {"v":"山"}',
    '',
    '',
    'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
    '',
    '',
    'event: close',
    'data: {"click_behavior":"none","auto_resume":false}',
    '',
    '',
  ].join("\n");
  const out = parse(sse);
  const content = out.filter((e) => e.content).map((e) => e.content).join("");
  assert.equal(content, "《秋日山");
  assert.deepEqual(out.filter((e) => e.finish), [{ finish: "stop" }]);
});

test("createDeepseekSseParser: bare v chunks continue APPEND context across chunks", () => {
  const parse = createDeepseekSseParser();
  const out1 = parse('data: {"p":"response/fragments/-1/content","o":"APPEND","v":"你"}\n\n');
  const out2 = parse('data: {"v":"好"}\n\ndata: {"v":"！"}\n\n');
  assert.deepEqual(out1, [{ content: "你" }]);
  assert.deepEqual(out2, [{ content: "好" }, { content: "！" }]);
});

test("createDeepseekSseParser: THINKING fragment routes to reasoning", () => {
  const parse = createDeepseekSseParser();
  const out = parse([
    'data: {"v":{"response":{"fragments":[{"type":"THINKING","content":"思考"}]}}}',
    '',
    '',
    'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"中"}',
    '',
    '',
    'data: {"v":{"response":{"fragments":[{"type":"THINKING","content":"思考中"},{"type":"RESPONSE","content":"答"}]}}}',
    '',
    '',
    'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
    '',
    '',
  ].join("\n"));
  const reasoning = out.filter((e) => e.reasoning).map((e) => e.reasoning).join("");
  const content = out.filter((e) => e.content).map((e) => e.content).join("");
  assert.equal(reasoning, "思考中");
  assert.equal(content, "答");
  assert.deepEqual(out.filter((e) => e.finish), [{ finish: "stop" }]);
});

test("createDeepseekSseParser: snapshot repeat does not duplicate (unseen suffix)", () => {
  const parse = createDeepseekSseParser();
  parse('data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"hello world"}]}}}\n\n');
  const out = parse('data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"hello world again"}]}}}\n\n');
  assert.deepEqual(out, [{ content: " again" }]);
});

test("createDeepseekSseParser: expert real capture (empty THINK fragment + bare v + boundary switch)", () => {
  // 2026-09-05 真机抓包：expert 模式 THINK fragment 以空对象 {} 下发（无 type 字段），
  // 思考与正文增量都是裸 {v} 沿用上下文，唯一边界是 elapsed_secs SET。
  const parse = createDeepseekSseParser({ startKind: "reasoning" });
  const sse = [
    'data: {"v":{"response":{"message_id":2,"role":"ASSISTANT","status":"WIP","fragments":[{}]}}}',
    '',
    'data: {"v":"用户要求一句话"}',
    '',
    'data: {"v":"要简洁。"}',
    '',
    'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"回答"}',
    '',
    'data: {"p":"response/fragments/-1/elapsed_secs","o":"SET","v":2.27}',
    '',
    'data: {"v":{"response":{"fragments":[{"id":3,"type":"RESPONSE","content":"我是"}]}}}',
    '',
    'data: {"p":"response/fragments/-1/content","v":"由"}',
    '',
    'data: {"v":"深度求索创造"}',
    '',
    'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
    '',
  ].join("\n");
  const out = parse(sse);
  const reasoning = out.filter((e) => e.reasoning).map((e) => e.reasoning).join("");
  const content = out.filter((e) => e.content).map((e) => e.content).join("");
  assert.equal(reasoning, "用户要求一句话要简洁。回答");
  assert.equal(content, "我是由深度求索创造");
  assert.deepEqual(out.filter((e) => e.finish), [{ finish: "stop" }]);
});

test("createDeepseekSseParser: buildUpstreamBody passes expert flag", () => {
  const body = buildUpstreamBody({ sessionId: "s", prompt: "p", thinking: true, search: false, expert: true });
  assert.equal(body.model_type, "expert");
  assert.equal(body.thinking_enabled, true);
  assert.equal(buildUpstreamBody({ sessionId: "s", prompt: "p", thinking: false, search: false, expert: false }).model_type, undefined);
});
test("createDeepseekSseParser: BATCH patch with nested status", () => {
  const parse = createDeepseekSseParser();
  const out = parse('data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":37},{"p":"quasi_status","v":"FINISHED"}]}\n\ndata: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n');
  assert.deepEqual(out, [{ finish: "stop" }]);
});

test("createDeepseekSseParser: buffers partial events across chunks", () => {
  const parse = createDeepseekSseParser();
  assert.deepEqual(parse('data: {"p":"response/fragments/-1/content","o":"APPEND","v":"he'), []);
  const out = parse('llo"}\n\ndata: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n');
  assert.deepEqual(out, [{ content: "hello" }, { finish: "stop" }]);
});

test("buildUpstreamBody has exact upstream shape", () => {
  assert.deepEqual(
    buildUpstreamBody({ sessionId: "s1", prompt: "p", thinking: true, search: false }),
    {
      chat_session_id: "s1",
      parent_message_id: null,
      prompt: "p",
      ref_file_ids: [],
      thinking_enabled: true,
      search_enabled: false,
    }
  );
});
