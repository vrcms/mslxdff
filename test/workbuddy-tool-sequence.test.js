import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeToolSequence } from "../src/providers/workbuddy/sanitize-tools.js";

function call(id, name = "bash") {
  return { id, type: "function", function: { name, arguments: "{}" } };
}

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
  assert.equal(r.messages[0].tool_calls.length, 1);
  assert.equal(r.messages[0].tool_calls[0].id, "c1");
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
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].content, "partial answer");
  assert.equal(r.messages[0].tool_calls, undefined);
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
