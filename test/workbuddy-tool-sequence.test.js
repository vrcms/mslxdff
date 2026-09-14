import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeToolSequence } from "../src/providers/workbuddy/sanitize-tools.js";

function call(id, name = "bash") {
  return { id, type: "function", function: { name, arguments: "{}" } };
}

test("sanitize: interrupted pairing — result is moved up right after its call", () => {
  const msgs = [
    { role: "assistant", content: "", tool_calls: [call("c1")] },
    { role: "user", content: "打断" },
    { role: "tool", tool_call_id: "c1", name: "bash", content: "ok" },
  ];
  const r = sanitizeToolSequence(msgs);
  assert.equal(r.droppedCalls, 0);
  assert.equal(r.droppedResults, 0);
  assert.equal(r.movedResults, 1, "结果被移动");
  assert.equal(r.injectedHead, 1, "首条为带调用的 assistant → 注入占位 user");
  assert.deepEqual(r.messages.map((m) => m.role), ["user", "assistant", "tool", "user"], "占位 user 后 tool 紧跟 assistant");
});

test("sanitize: interleaved assistants — each result moves after its own call", () => {
  const msgs = [
    { role: "assistant", content: "", tool_calls: [call("c1")] },
    { role: "assistant", content: "", tool_calls: [call("c2")] },
    { role: "tool", tool_call_id: "c1", name: "bash", content: "r1" },
    { role: "tool", tool_call_id: "c2", name: "bash", content: "r2" },
  ];
  const r = sanitizeToolSequence(msgs);
  assert.equal(r.movedResults, 2);
  assert.deepEqual(r.messages.map((m) => m.role), ["user", "assistant", "tool", "assistant", "tool"]);
  assert.equal(r.messages[2].tool_call_id, "c1");
  assert.equal(r.messages[4].tool_call_id, "c2");
});

test("sanitize: parallel calls keep adjacency without move when already right after", () => {
  const msgs = [
    { role: "assistant", content: "", tool_calls: [call("c1"), call("c2")] },
    { role: "tool", tool_call_id: "c2", name: "bash", content: "r2" },
    { role: "tool", tool_call_id: "c1", name: "bash", content: "r1" },
  ];
  const r = sanitizeToolSequence(msgs);
  assert.equal(r.movedResults, 0, "窗口内交换不算移动");
  assert.deepEqual(r.messages.map((m) => m.tool_call_id).filter(Boolean), ["c1", "c2"], "结果按 calls 顺序输出");
});

test("sanitize: duplicate tool result is dropped once", () => {
  const msgs = [
    { role: "assistant", content: "", tool_calls: [call("c1")] },
    { role: "tool", tool_call_id: "c1", name: "bash", content: "first" },
    { role: "tool", tool_call_id: "c1", name: "bash", content: "dup" },
  ];
  const r = sanitizeToolSequence(msgs);
  assert.equal(r.droppedResults, 1);
  assert.equal(r.messages.length, 3, "占位 user + assistant + tool");
  assert.equal(r.messages[2].content, "first");
});

test("sanitize: user-first sequence gets no head injection", () => {
  const msgs = [
    { role: "user", content: "go" },
    { role: "assistant", content: "", tool_calls: [call("c1")] },
    { role: "tool", tool_call_id: "c1", name: "bash", content: "ok" },
  ];
  const r = sanitizeToolSequence(msgs);
  assert.equal(r.injectedHead, 0);
  assert.equal(r.messages[0].role, "user");
  assert.equal(r.messages[0].content, "go");
});

test("sanitize: empty result after orphan drop does not inject", () => {
  const r = sanitizeToolSequence([{ role: "tool", tool_call_id: "ghost", content: "x" }]);
  assert.equal(r.messages.length, 0);
  assert.equal(r.injectedHead, 0);
});

test("sanitize: fully paired sequence passes through untouched", () => {
  const msgs = [
    { role: "user", content: "go" },
    { role: "assistant", content: "", tool_calls: [call("c1")] },
    { role: "tool", tool_call_id: "c1", name: "bash", content: "ok" },
  ];
  const r = sanitizeToolSequence(msgs);
  assert.equal(r.droppedCalls, 0);
  assert.equal(r.droppedResults, 0);
  assert.equal(r.messages.length, 3);
  assert.equal(r.messages[1].tool_calls.length, 1);
});

test("sanitize: call without result is dropped", () => {
  const msgs = [
    { role: "assistant", content: "thinking", tool_calls: [call("c1"), call("c2")] },
    { role: "tool", tool_call_id: "c1", name: "bash", content: "ok" },
  ];
  const r = sanitizeToolSequence(msgs);
  assert.equal(r.droppedCalls, 1);
  assert.equal(r.droppedResults, 0);
  assert.equal(r.injectedHead, 1, "首条为带调用的 assistant → 注入占位 user");
  assert.equal(r.messages[0].role, "user");
  assert.equal(r.messages[1].tool_calls.length, 1);
  assert.equal(r.messages[1].tool_calls[0].id, "c1");
});

test("sanitize: orphan tool result is dropped", () => {
  const msgs = [
    { role: "user", content: "hi" },
    { role: "tool", tool_call_id: "ghost", name: "bash", content: "stale output" },
    { role: "assistant", content: "done" },
  ];
  const r = sanitizeToolSequence(msgs);
  assert.equal(r.droppedCalls, 0);
  assert.equal(r.droppedResults, 1);
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages.some((m) => m.role === "tool"), false);
});

test("sanitize: assistant with all calls dropped and no text is removed", () => {
  const msgs = [
    { role: "assistant", content: "", tool_calls: [call("c1")] },
    { role: "user", content: "next" },
  ];
  const r = sanitizeToolSequence(msgs);
  assert.equal(r.droppedCalls, 1);
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].role, "user");
});

test("sanitize: assistant with all calls dropped keeps its text", () => {
  const msgs = [
    { role: "assistant", content: "partial answer", tool_calls: [call("c1")] },
  ];
  const r = sanitizeToolSequence(msgs);
  assert.equal(r.droppedCalls, 1);
  assert.equal(r.messages.length, 2, "占位 user + 保留文本的 assistant");
  assert.equal(r.messages[0].role, "user");
  assert.equal(r.messages[1].content, "partial answer");
  assert.equal(r.messages[1].tool_calls, undefined);
});

test("sanitize: empty call id and missing tool_call_id never pair", () => {
  const msgs = [
    { role: "assistant", content: "", tool_calls: [{ type: "function", function: { name: "bash", arguments: "{}" } }] },
    { role: "tool", name: "bash", content: "no id" },
  ];
  const r = sanitizeToolSequence(msgs);
  assert.equal(r.droppedCalls, 1);
  assert.equal(r.droppedResults, 1);
  assert.equal(r.messages.length, 0);
});

test("sanitize: non-array input is tolerated", () => {
  assert.deepEqual(sanitizeToolSequence(undefined).messages, []);
  assert.deepEqual(sanitizeToolSequence(null).messages, []);
});
