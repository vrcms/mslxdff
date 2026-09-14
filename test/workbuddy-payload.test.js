import { test } from "node:test";
import assert from "node:assert/strict";
import { rewriteWorkbuddyPayload } from "../src/providers/workbuddy/payload.js";

function body(extra = {}) {
  return { model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], ...extra };
}

test("payload: deepseek without thinking gets enabled + default effort", () => {
  const out = rewriteWorkbuddyPayload(body());
  assert.deepEqual(out.thinking, { type: "enabled" });
  assert.equal(out.reasoning_effort, "high");
});

test("payload: explicit thinking disabled strips effort", () => {
  const out = rewriteWorkbuddyPayload(body({ thinking: { type: "disabled" }, reasoning_effort: "high" }));
  assert.deepEqual(out.thinking, { type: "disabled" });
  assert.equal("reasoning_effort" in out, false);
});

test("payload: existing effort is never overwritten", () => {
  const out = rewriteWorkbuddyPayload(body({ reasoning_effort: "low" }));
  assert.equal(out.reasoning_effort, "low");
  assert.deepEqual(out.thinking, { type: "enabled" });
});

test("payload: reasoning trace backfills all assistant messages", () => {
  const out = rewriteWorkbuddyPayload(body({
    messages: [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1", reasoning_content: "thought-1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] },
    ],
  }));
  assert.equal(out.messages[1].reasoning_content, "thought-1");
  assert.equal(out.messages[3].reasoning_content, "");
});

test("payload: no reasoning trace means no backfill", () => {
  const out = rewriteWorkbuddyPayload(body({
    messages: [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ],
  }));
  assert.equal("reasoning_content" in out.messages[1], false);
});

test("payload: non-deepseek models skip thinking injection", () => {
  const out = rewriteWorkbuddyPayload({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] });
  assert.equal("thinking" in out, false);
  assert.equal("reasoning_effort" in out, false);
});

test("payload: developer role normalized to system", () => {
  const out = rewriteWorkbuddyPayload({ model: "glm-5.3-flash", messages: [{ role: "developer", content: "sys" }] });
  assert.equal(out.messages[0].role, "system");
});

test("payload: tool_choice object forms normalized to string", () => {
  const a = rewriteWorkbuddyPayload(body({ tool_choice: { type: "auto" } }));
  assert.equal(a.tool_choice, "auto");
  const b = rewriteWorkbuddyPayload(body({ tool_choice: { type: "function", function: { name: "bash" } } }));
  assert.equal(b.tool_choice, "bash");
  const c = rewriteWorkbuddyPayload(body({ tool_choice: { type: "none" }, tools: [{ type: "function" }] }));
  assert.equal("tool_choice" in c, false);
  assert.equal("tools" in c, false);
});

test("payload: original body is not mutated", () => {
  const src = body();
  rewriteWorkbuddyPayload(src);
  assert.equal("thinking" in src, false);
  assert.equal("reasoning_effort" in src, false);
});
