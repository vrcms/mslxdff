// codearts SSE 解析测试：全文快照替换语义 / delta / tool_calls / [DONE] / 内嵌错误映射 / OpenAI 转换。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createSseState, scanLine, applyEvent, sortedToolCalls, embeddedErrorFromData } from "../src/providers/codearts/sse.js";
import { sseToOpenAIResponse, aggregateToCompletion, preflightResponse, newChatId } from "../src/providers/codearts/stream.js";

function feed(lines) {
  const st = createSseState();
  const pend = { pendingEvent: "" };
  for (const line of lines) {
    const ev = scanLine(line, pend);
    if (ev) applyEvent(st, ev.event, ev.data);
  }
  return st;
}

function sseResponse(frames) {
  const body = frames.map((f) => `data: ${f}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("codearts sse 解析", () => {
  test("scanLine：data 立即触发；event 暂存；空行只清暂存", () => {
    const st = { pendingEvent: "" };
    assert.equal(scanLine("event: reasoning", st), null);
    assert.equal(st.pendingEvent, "reasoning");
    const ev = scanLine("data: {\"text\":\"hi\"}", st);
    assert.deepEqual(ev, { event: "reasoning", data: "{\"text\":\"hi\"}" });
    assert.equal(st.pendingEvent, "");
    assert.equal(scanLine("", st), null);
    assert.equal(scanLine(": keep-alive", st), null);
  });

  test("全文快照帧：text 是累计全文 → 替换语义产出正确 delta", () => {
    const st = feed([
      "data: {\"id\":1,\"model\":\"GLM-4.7\",\"type\":\"answer\"}",
      "data: {\"text\":\"你好\",\"prompt_tokens\":10}",
      "data: {\"text\":\"你好世界\",\"completion_tokens\":5}",
      "data: {\"text\":\"[DONE]\",\"error_code\":\"0\"}",
    ]);
    assert.equal(st.content, "你好世界");
    assert.equal(st.reason, "");
    assert.equal(st.finish, "stop");
    assert.deepEqual(st.usage, { prompt_tokens: 10, completion_tokens: 5 });
    assert.equal(st.done, true);
  });

  test("OpenAI 增量帧：choices[0].delta 与顶层 delta 双兼容", () => {
    const st = feed([
      "data: {\"choices\":[{\"delta\":{\"content\":\"A\"}}]}",
      "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think\"}}]}",
      "data: {\"delta\":{\"content\":\"B\"}}",
      "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}",
    ]);
    assert.equal(st.content, "AB");
    assert.equal(st.reason, "think");
    assert.equal(st.finish, "tool_calls");
  });

  test("tool_calls 分片按 index 聚合", () => {
    const st = feed([
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"rea\"}}]}}]}",
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"x\\\":1}\"}}]}}]}",
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"call_2\",\"type\":\"function\",\"function\":{\"name\":\"f2\"}}]}}]}",
    ]);
    const calls = sortedToolCalls(st);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { index: 0, type: "function", id: "call_1", function: { name: "rea", arguments: "{\"x\":1}" } });
    assert.deepEqual(calls[1].id, "call_2");
  });

  test("reasoning 事件追加；done/end/finish 定 finish；杂帧忽略", () => {
    const st = feed([
      "event: reasoning",
      "data: {\"text\":\"思考中\"}",
      "data: {\"related_question_answer\":{\"x\":1}}",
      "event: done",
      "data: {\"finish_reason\":\"stop\"}",
    ]);
    assert.equal(st.reason, "思考中");
    assert.equal(st.finish, "stop");
    assert.equal(st.done, true);
  });

  test("内嵌错误帧：429/400/502 映射", () => {
    assert.equal(embeddedErrorFromData("{\"error_code\":\"tm.00001041.429\",\"error_msg\":\"并发会话超限\"}")?.status, 429);
    assert.equal(embeddedErrorFromData("{\"error_code\":\"InferHub.002002009.404\",\"error_msg\":\"model is not registered\"}")?.status, 400);
    assert.equal(embeddedErrorFromData("{\"error_code\":\"4004.200\",\"error_msg\":\"benefit not found\"}")?.status, 400);
    assert.equal(embeddedErrorFromData("{\"error_code\":\"X.1\",\"error_msg\":\"boom\"}")?.status, 502);
    assert.equal(embeddedErrorFromData("{\"error_code\":\"0\"}"), null);
    assert.equal(embeddedErrorFromData("[DONE]"), null);
  });

  test("sseToOpenAIResponse：快照→增量 chunk + finish + [DONE]", async () => {
    const resp = sseResponse([
      "{\"id\":1,\"type\":\"answer\"}",
      "{\"text\":\"你好\"}",
      "{\"text\":\"你好世界\"}",
      "{\"text\":\"[DONE]\",\"error_code\":\"0\"}",
    ]);
    const out = sseToOpenAIResponse(resp, { model: "GLM-4.7", id: "chatcmpl-x" });
    const text = await out.text();
    const lines = text.split("\n").filter((l) => l.startsWith("data: "));
    assert.equal(lines[lines.length - 1], "data: [DONE]");
    const deltas = lines.slice(0, -2).map((l) => JSON.parse(l.slice(6)));
    const contents = deltas.map((c) => c.choices?.[0]?.delta?.content).filter(Boolean);
    assert.deepEqual(contents, ["你好", "世界"]);
    const finish = lines.slice(0, -1).map((l) => JSON.parse(l.slice(6))).find((c) => c.choices?.[0]?.finish_reason);
    assert.equal(finish.choices[0].finish_reason, "stop");
    assert.equal(deltas[0].object, "chat.completion.chunk");
    assert.equal(deltas[0].model, "GLM-4.7");
  });

  test("aggregateToCompletion：聚合成 chat.completion（含 reasoning/tool_calls/usage）", async () => {
    const resp = sseResponse([
      "{\"text\":\"\",\"output\":[],\"prompt_tokens\":7}",
      "{\"choices\":[{\"delta\":{\"reasoning_content\":\"想\"}}]}",
      "{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"grep\",\"arguments\":\"{}\"}}]}}]}",
      "{\"choices\":[{\"delta\":{\"content\":\"答案\"}}]}",
      "{\"text\":\"[DONE]\",\"error_code\":\"0\",\"completion_tokens\":9}",
    ]);
    const out = await aggregateToCompletion(resp, { model: "GLM-4.7", id: "chatcmpl-y" });
    assert.equal(out.object, "chat.completion");
    assert.equal(out.model, "GLM-4.7");
    const msg = out.choices[0].message;
    assert.equal(msg.content, "答案");
    assert.equal(msg.reasoning_content, "想");
    assert.equal(msg.tool_calls[0].function.name, "grep");
    assert.equal(out.choices[0].finish_reason, "stop");
    assert.deepEqual(out.usage, { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 });
  });

  test("preflightResponse：正常首帧回放不丢内容；内嵌错误抛 UpstreamEventError", async () => {
    const ok = await preflightResponse(sseResponse(["{\"type\":\"answer\"}", "{\"text\":\"hi\"}"]));
    const text = await ok.text();
    assert.ok(text.includes("\"text\":\"hi\""));
    const bad = sseResponse(["{\"error_code\":\"InferHub.002002009.404\",\"error_msg\":\"model is not registered\"}"]);
    await assert.rejects(() => preflightResponse(bad), (e) => e.status === 400 && /002002009/.test(e.message));
  });

  test("newChatId：透传 32hex / 非法输入派生稳定 32hex", () => {
    const hex32 = "0123456789abcdef0123456789abcdef";
    assert.equal(newChatId({ chat_id: hex32 }), hex32);
    assert.equal(newChatId({ conversation_id: "sess-abc" }, { sessionId: "s" }), newChatId({ conversation_id: "sess-abc" }, { sessionId: "s" }));
    assert.match(newChatId({}), /^[0-9a-f]{32}$/);
    assert.match(newChatId({ chat_id: "not-hex!" }), /^[0-9a-f]{32}$/);
  });
});
