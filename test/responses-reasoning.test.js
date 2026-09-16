import { test } from "node:test";
import assert from "node:assert/strict";
import { responsesToChatBody, createChunkTranslator } from "../src/responses/translate.js";
import { toModelPrompt } from "../src/upstream-engine/sdk/convert.js";
import { createSseSerializer } from "../src/upstream-engine/sdk/sse.js";

test("入站：reasoning item 挂到下一条 assistant（function_call）消息，不丢加密态", () => {
  const body = responsesToChatBody({
    model: "muse-spark-1.3-contributor-free",
    input: [
      { type: "message", role: "user", content: "hi" },
      { type: "reasoning", id: "rs_abc", encrypted_content: "ENC123", summary: [{ type: "summary_text", text: "想了下" }] },
      { type: "function_call", call_id: "call_1", name: "f", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ],
    stream: true,
  });
  const asst = body.messages.find((m) => m.role === "assistant");
  assert.ok(asst, "应有 assistant 消息");
  assert.equal(asst.reasoning_items.length, 1);
  assert.equal(asst.reasoning_items[0].id, "rs_abc");
  assert.equal(asst.reasoning_items[0].encrypted_content, "ENC123");
  assert.equal(asst.tool_calls.length, 1);
});

test("出站：reasoning_items → reasoning part（providerOptions.openai.itemId + reasoningEncryptedContent）", () => {
  const prompt = toModelPrompt([
    {
      role: "assistant",
      content: "",
      reasoning_items: [{ id: "rs_abc", encrypted_content: "ENC123", summary: [{ text: "s" }] }],
      tool_calls: [{ id: "call_1", function: { name: "f", arguments: "{}" } }],
    },
  ]);
  const parts = prompt[0].content;
  const rp = parts.find((p) => p.type === "reasoning");
  assert.ok(rp, "应有 reasoning part");
  assert.equal(rp.providerOptions.openai.itemId, "rs_abc");
  assert.equal(rp.providerOptions.openai.reasoningEncryptedContent, "ENC123");
  assert.equal(parts.filter((p) => p.type === "tool-call").length, 1);
});

test("sse：reasoning-start 即时透出 x_reasoning_item（含加密态）；delta 带 reasoning_content", () => {
  const ser = createSseSerializer();
  const out0 = ser.push({ type: "reasoning-start", id: "rs_abc", providerMetadata: { openai: { itemId: "rs_abc", reasoningEncryptedContent: "ENC123" } } });
  const f0 = out0.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))).find((x) => x.x_reasoning_item);
  assert.ok(f0, "start 帧应带 x_reasoning_item");
  assert.equal(f0.x_reasoning_item.id, "rs_abc");
  assert.equal(f0.x_reasoning_item.encrypted_content, "ENC123");

  const out = ser.push({ type: "reasoning-delta", id: "rs_abc:0", delta: "思考" });
  const frames = out.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
  const j = frames.find((x) => x.choices?.[0]?.delta?.reasoning_content);
  assert.equal(j.choices[0].delta.reasoning_content, "思考");
});

test("translator：x_reasoning_item → reasoning item 事件（含 encrypted_content），且思考不进正文", () => {
  const t = createChunkTranslator("muse-spark-1.3-contributor-free");
  const evs = [];
  const push = (obj) => { evs.push(...t.push(`data: ${JSON.stringify(obj)}\n\n`)); };
  push({ choices: [{ delta: { role: "assistant" } }] });
  push({ choices: [{ delta: { reasoning_content: "想" } }], x_reasoning_item: { id: "rs_abc", encrypted_content: "ENC123" } });
  push({ choices: [{ delta: { reasoning_content: "了想" } }], x_reasoning_id: "rs_abc" });
  push({ choices: [{ delta: { content: "回答" } }] });
  push({ choices: [{ delta: { finish_reason: "stop" } }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
  evs.push(...t.end({ finish: "stop", usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));

  const added = evs.find((e) => e.type === "response.output_item.added" && e.item.type === "reasoning");
  assert.ok(added, "应有 reasoning item added");
  assert.equal(added.output_index, 0, "reasoning 先出现占 index 0");
  assert.equal(added.item.encrypted_content, "ENC123");
  assert.ok(added.item.id === "rs_abc");

  const done = evs.find((e) => e.type === "response.output_item.done" && e.item.type === "reasoning");
  assert.ok(done, "应有 reasoning item done");
  assert.equal(done.item.encrypted_content, "ENC123");
  assert.ok(evs.some((e) => e.type === "response.reasoning_summary_text.delta" && e.delta === "想"));

  const msgItem = evs.find((e) => e.type === "response.output_item.done" && e.item.type === "message");
  assert.equal(msgItem.item.content[0].text, "回答", "思考不得混入正文");
  assert.equal(msgItem.output_index, 1, "message 排在 reasoning 之后");
});

test("translator：无 reasoning 时行为不变（message output_index 0）", () => {
  const t = createChunkTranslator("m");
  const evs = [];
  evs.push(...t.push(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`));
  evs.push(...t.end({}));
  const msgItem = evs.find((e) => e.type === "response.output_item.added" && e.item.type === "message");
  assert.equal(msgItem.output_index, 0);
});

test("入站：无 type 的 message（responses 规范 type 可省，AI SDK/opencode 就不发）必须保留", () => {
  const body = responsesToChatBody({
    model: "m",
    input: [
      { role: "developer", content: "You are OpenCode..." },
      { role: "user", content: [{ type: "input_text", text: "你好，我是20209933" }] },
      { role: "assistant", content: [{ type: "output_text", text: "Hi there!" }] },
      { role: "user", content: [{ type: "input_text", text: "你可以重复我的话吗，比如，你说：你好，20209933" }] },
    ],
    stream: true,
  });
  assert.equal(body.messages.length, 4, "四条消息一条都不能丢");
  assert.equal(body.messages[0].role, "developer");
  assert.equal(body.messages[1].content, "你好，我是20209933");
  assert.equal(body.messages[3].content, "你可以重复我的话吗，比如，你说：你好，20209933");
});

test("dropEncrypted：剥掉加密态——留摘要文本、无摘要整条跳过、明文 reasoning_content 兜底", () => {
  const msgs = [
    { role: "assistant", content: "a1", reasoning_items: [{ id: "rs_1", encrypted_content: "ENC1", summary: [{ text: "摘要一" }] }] },
    { role: "user", content: "u2" },
    { role: "assistant", content: "a3", reasoning_items: [{ id: "rs_3", encrypted_content: "ENC3", summary: [] }], reasoning_content: "明文思考" },
    { role: "user", content: "u4" },
    { role: "assistant", content: "a5", reasoning_items: [{ id: "rs_5", encrypted_content: "ENC5" }] },
  ];
  const prompt = toModelPrompt(msgs, { dropEncrypted: true });
  const p0 = prompt[0].content.filter((p) => p.type === "reasoning");
  assert.equal(p0.length, 1);
  assert.equal(p0[0].text, "摘要一");
  assert.equal(p0[0].providerOptions, undefined, "不得带加密态");
  const p2 = prompt[2].content.filter((p) => p.type === "reasoning");
  assert.equal(p2.length, 1, "无摘要的加密 item 应跳过而非留空占位");
  assert.equal(p2[0].text, "明文思考");
  assert.equal(p2[0].providerOptions, undefined);
  const p4 = prompt[4].content.filter((p) => p.type === "reasoning");
  assert.equal(p4.length, 0, "无摘要无明文 → 不带任何 reasoning part");
  const keep = toModelPrompt(msgs, {});
  const k0 = keep[0].content.find((p) => p.type === "reasoning");
  assert.equal(k0.providerOptions.openai.reasoningEncryptedContent, "ENC1", "默认路径仍带加密态");
});
