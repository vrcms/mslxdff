import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSseSerializer, usageToOpenAI } from "../src/upstream-engine/sdk/sse.js";

function parseFrames(text) {
  return text.split("\n\n").filter(Boolean).map((block) => {
    const line = block.trim();
    if (line === "data: [DONE]") return "[DONE]";
    return JSON.parse(line.slice(5).trim());
  });
}

describe("createSseSerializer", () => {
  it("首个 delta 前自动补一次 role 帧，后续不再补", () => {
    const s = createSseSerializer();
    const out1 = s.push({ type: "reasoning-delta", delta: "想" });
    const out2 = s.push({ type: "text-delta", delta: "答" });
    const frames = parseFrames(out1 + out2);
    assert.equal(frames[0].choices[0].delta.role, "assistant");
    assert.equal(frames.filter((f) => f.choices[0].delta.role).length, 1, "role 只出现一次");
  });

  it("reasoning-delta/text-delta → reasoning_content/content 帧", () => {
    const s = createSseSerializer();
    const text = s.push({ type: "reasoning-delta", delta: "让我" }) + s.push({ type: "text-delta", delta: "答案" });
    const frames = parseFrames(text);
    assert.equal(frames[1].choices[0].delta.reasoning_content, "让我");
    assert.equal(frames[2].choices[0].delta.content, "答案");
  });

  it("tool-input-start/delta → tool_calls 帧；随后 tool-call 不重复", () => {
    const s = createSseSerializer();
    let text = "";
    text += s.push({ type: "tool-input-start", id: "call_1", toolName: "get_weather" });
    text += s.push({ type: "tool-input-delta", id: "call_1", delta: '{"city"' });
    text += s.push({ type: "tool-input-delta", id: "call_1", delta: ':"北京"}' });
    assert.equal(s.push({ type: "tool-call", toolCallId: "call_1", toolName: "get_weather", input: { city: "北京" } }), null, "已发过 delta 的 tool-call 抑制");
    const frames = parseFrames(text);
    const tcFrames = frames.filter((f) => f.choices[0].delta.tool_calls);
    assert.equal(tcFrames[0].choices[0].delta.tool_calls[0].id, "call_1");
    assert.equal(tcFrames[0].choices[0].delta.tool_calls[0].function.name, "get_weather");
    assert.equal(tcFrames[1].choices[0].delta.tool_calls[0].function.arguments, '{"city"');
    assert.equal(tcFrames[2].choices[0].delta.tool_calls[0].function.arguments, ':"北京"}');
  });

  it("无 delta 的 tool-call → 发完整一帧", () => {
    const s = createSseSerializer();
    const text = s.push({ type: "tool-call", toolCallId: "call_9", toolName: "f", input: { a: 1 } });
    const frames = parseFrames(text);
    const call = frames.find((f) => f.choices[0].delta.tool_calls);
    assert.equal(call.choices[0].delta.tool_calls[0].id, "call_9");
    assert.equal(call.choices[0].delta.tool_calls[0].function.arguments, '{"a":1}');
  });

  it("finish → finish_reason + usage（raw 优先）；end → [DONE]", () => {
    const s = createSseSerializer();
    const raw = { prompt_tokens: 15, completion_tokens: 236, total_tokens: 251 };
    const text = s.push({
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 15 }, outputTokens: { total: 236 }, raw },
    });
    const frames = parseFrames(text);
    assert.equal(frames[0].choices[0].finish_reason, "stop");
    assert.deepEqual(frames[0].usage, raw);
    assert.equal(s.end(), "data: [DONE]\n\n");
  });

  it("finish（V2 字符串口径）→ finish_reason 归一；tool-calls 映射 OpenAI tool_calls", () => {
    const s = createSseSerializer();
    const f1 = parseFrames(s.push({ type: "finish", finishReason: "length", usage: { inputTokens: 7, outputTokens: 9, totalTokens: 16 } }));
    assert.equal(f1[0].choices[0].finish_reason, "length");
    assert.deepEqual(f1[0].usage, { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 });
    const s2 = createSseSerializer();
    const f2 = parseFrames(s2.push({ type: "finish", finishReason: "tool-calls" }));
    assert.equal(f2[0].choices[0].finish_reason, "tool_calls");
  });

  it("response-metadata 更新 id/model", () => {
    const s = createSseSerializer();
    s.push({ type: "response-metadata", id: "cmb-x", modelId: "glm-5.3-flash", timestamp: "2026-09-12T10:00:00.000Z" });
    const frames = parseFrames(s.push({ type: "text-delta", delta: "hi" }));
    const content = frames.find((f) => f.choices[0].delta.content);
    assert.equal(content.id, "cmb-x");
    assert.equal(content.model, "glm-5.3-flash");
  });

  it("error part → error 帧；未知 part 忽略", () => {
    const s = createSseSerializer();
    assert.equal(s.push({ type: "stream-start" }), null);
    const text = s.push({ type: "error", error: { message: "boom" } });
    const frames = parseFrames(text);
    assert.equal(frames[0].error.message, "boom");
  });
});

describe("usageToOpenAI", () => {
  it("V3 嵌套（openai@3）：无 raw 时用 inputTokens/outputTokens 归一", () => {
    assert.deepEqual(
      usageToOpenAI({ inputTokens: { total: 10 }, outputTokens: { total: 5 } }),
      { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    );
    assert.equal(usageToOpenAI(undefined), undefined);
  });

  it("V2 扁平（openai-compatible@2）：inputTokens/outputTokens 为 number 不再归零", () => {
    assert.deepEqual(
      usageToOpenAI({ inputTokens: 15, outputTokens: 236, totalTokens: 251 }),
      { prompt_tokens: 15, completion_tokens: 236, total_tokens: 251 },
    );
    assert.deepEqual(
      usageToOpenAI({ inputTokens: 3, outputTokens: 4 }),
      { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    );
  });

  it("Responses 口径 raw（input_tokens/output_tokens）→ chat 口径归一 + details", () => {
    assert.deepEqual(
      usageToOpenAI({
        raw: {
          input_tokens: 14,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 651,
          output_tokens_details: { reasoning_tokens: 640 },
        },
      }),
      {
        prompt_tokens: 14,
        completion_tokens: 651,
        total_tokens: 665,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 640 },
      },
    );
  });
});
