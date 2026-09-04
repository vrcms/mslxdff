import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { responsesToChatBody, chatJsonToResponse, createChunkTranslator, chunkToString } from "../src/responses/translate.js";
import { createCollector, createLiveForwarder } from "../src/routes/responses-route.js";

describe("toResponsesUsage", () => {
  test("chat 口径转 Responses 口径（含 details 透传）", async () => {
    const { toResponsesUsage } = await import("../src/responses/translate.js");
    assert.deepEqual(toResponsesUsage({ prompt_tokens: 10, completion_tokens: 6, total_tokens: 16, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } }), {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens: 6,
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 16,
    });
    assert.deepEqual(toResponsesUsage(null), {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    });
  });

  test("completed 事件必带 input_tokens（codex 硬解码）", () => {
    const t = createChunkTranslator("m");
    t.begin();
    t.push('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
    const tail = t.end({ finish: "stop", usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
    const done = tail.find((e) => e.type === "response.completed");
    assert.equal(done.response.usage.input_tokens, 3);
    assert.equal(done.response.usage.output_tokens, 1);
    assert.equal(done.response.usage.total_tokens, 4);
  });
});

describe("chunkToString", () => {
  test("Uint8Array/Buffer 解码而非数字串", () => {
    const raw = 'data: {"a":1}\n\n';
    assert.equal(chunkToString(new TextEncoder().encode(raw)), raw);
    assert.equal(chunkToString(Buffer.from(raw, "utf8")), raw);
    assert.equal(chunkToString(raw), raw);
    assert.equal(chunkToString(null), "");
  });

  test("translator 直接吃 Uint8Array 也出 delta", () => {
    const t = createChunkTranslator("m");
    t.begin();
    const evs = t.push(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
    assert.ok(evs.some((e) => e.type === "response.output_text.delta" && e.delta === "x"));
  });
});

describe("responses res shims", () => {
  test("垫片支持 res.on('close')（relay 断开感知所需）", () => {
    const cap = createCollector();
    let closed = 0;
    cap.res.on("close", () => closed++);
    cap.res.emit("close");
    assert.equal(closed, 1);
    const writes = [];
    const live = createLiveForwarder({ writeHead() {}, write: (c) => writes.push(String(c)), end() {} }, createChunkTranslator("m"));
    let liveClosed = 0;
    live.on("close", () => liveClosed++);
    live.emit("close");
    assert.equal(liveClosed, 1);
  });
});

describe("responsesToChatBody", () => {
  test("字符串 input → user 消息，instructions → system", () => {
    const b = responsesToChatBody({ model: "big-pickle", input: "hi", instructions: "sys" });
    assert.equal(b.model, "big-pickle");
    assert.deepEqual(b.messages, [{ role: "system", content: "sys" }, { role: "user", content: "hi" }]);
    assert.equal(b.stream, false);
  });

  test("数组 input：message + function_call_output 回填", () => {
    const b = responsesToChatBody({
      model: "m", stream: true, max_output_tokens: 50, temperature: 0.2,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "run it" }] },
        { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
      ],
      tools: [{ type: "function", name: "shell", description: "sh", parameters: { type: "object" } }],
      tool_choice: { type: "function", name: "shell" },
    });
    assert.equal(b.stream, true);
    assert.equal(b.max_tokens, 50);
    assert.equal(b.temperature, 0.2);
    assert.deepEqual(b.messages[0], { role: "user", content: "run it" });
    assert.deepEqual(b.messages[1].tool_calls, [{ id: "c1", type: "function", function: { name: "shell", arguments: "{}" } }]);
    assert.deepEqual(b.messages[2], { role: "tool", tool_call_id: "c1", content: "ok" });
    assert.equal(b.tools[0].type, "function");
    assert.deepEqual(b.tool_choice, { type: "function", function: { name: "shell" } });
  });

  test("缺 model 抛错", () => {
    assert.throws(() => responsesToChatBody({ input: "hi" }), /model/);
  });
});

describe("chatJsonToResponse", () => {
  test("文本 + tool_calls → Response 对象", () => {
    const r = chatJsonToResponse({
      id: "chatcmpl-1", model: "m",
      choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "sh", arguments: "{\"x\":1}" } }] } }],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    }, "m");
    assert.equal(r.object, "response");
    assert.equal(r.status, "completed");
    const fn = r.output.find((o) => o.type === "function_call");
    assert.equal(fn.call_id, "t1");
    assert.equal(fn.name, "sh");
    assert.equal(r.usage.total_tokens, 8);
  });
});

describe("createChunkTranslator", () => {
  test("文本 delta → responses 事件序列", () => {
    const t = createChunkTranslator("m");
    const head = t.begin();
    assert.equal(head[0].type, "response.created");
    const evs = t.push('data: {"choices":[{"delta":{"content":"hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
    assert.deepEqual(evs.map((e) => e.type), ["response.output_item.added", "response.content_part.added", "response.output_text.delta", "response.output_text.delta"]);
    assert.equal(evs.find((e) => e.type === "response.output_text.delta").delta, "hel");
    const tail = t.push("data: [DONE]\n\n") && t.end({ finish: "stop", usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
    const types = tail.map((e) => e.type);
    assert.ok(types.includes("response.output_text.done"));
    assert.ok(types.includes("response.completed"));
    assert.equal(tail[tail.length - 1].response.usage.total_tokens, 3);
  });

  test("注释行容忍 + tool_calls 累积成 function_call", () => {
    const t = createChunkTranslator("m");
    t.begin();
    const evs = t.push(': ping\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t9","function":{"name":"sh","arguments":"{\\"a\\":"}}]}}]}\n\n');
    assert.ok(evs.some((e) => e.type === "response.output_item.added"));
    const evs2 = t.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}\n\n');
    assert.ok(evs2.some((e) => e.type === "response.function_call_arguments.delta"));
    const tail = t.end({ finish: "tool_calls" });
    const fn = tail.find((e) => e.type === "response.output_item.done");
    assert.equal(fn.item.arguments, '{"a":1}');
  });
});
