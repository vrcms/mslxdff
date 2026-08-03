import { test } from "node:test";
import assert from "node:assert/strict";
import { injectReasoningContent, normalizeModel } from "../src/reasoning.js";

test("normalizeModel strips a single oc/ prefix", () => {
  assert.equal(normalizeModel("oc/deepseek-v4-flash-free"), "deepseek-v4-flash-free");
});

test("normalizeModel leaves other models verbatim", () => {
  assert.equal(normalizeModel("big-pickle"), "big-pickle");
  assert.equal(normalizeModel("deepseek-v4-flash-free"), "deepseek-v4-flash-free");
});

test("deepseek assistant messages get reasoning_content injected", () => {
  const injected = injectReasoningContent("deepseek-v4-flash-free", {
    messages: [{ role: "assistant", content: "hi" }],
  });
  assert.equal(injected.messages[0].reasoning_content, " ");
});

test("kimi assistant messages only get injection when they carry tool_calls", () => {
  const plain = injectReasoningContent("kimi-k2-free", {
    messages: [{ role: "assistant", content: "hi" }],
  });
  assert.equal(plain.messages[0].reasoning_content, undefined);

  const tooled = injectReasoningContent("kimi-k2-free", {
    messages: [{ role: "assistant", content: "", tool_calls: [{ id: "1" }] }],
  });
  assert.equal(tooled.messages[0].reasoning_content, " ");
});

test("messages already carrying reasoning_content are untouched", () => {
  const out = injectReasoningContent("deepseek-v4-flash-free", {
    messages: [{ role: "assistant", content: "hi", reasoning_content: "think" }],
  });
  assert.equal(out.messages[0].reasoning_content, "think");
});

test("non-deepseek/kimi models get no injection", () => {
  const out = injectReasoningContent("north-mini-code-free", {
    messages: [{ role: "assistant", content: "hi" }],
  });
  assert.equal(out.messages[0].reasoning_content, undefined);
});

test("input body is not mutated", () => {
  const body = { messages: [{ role: "assistant", content: "hi" }] };
  injectReasoningContent("deepseek-v4-flash-free", body);
  assert.equal(body.messages[0].reasoning_content, undefined);
});