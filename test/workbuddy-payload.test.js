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

// —— 11128 Claude Code 指纹剥离（上游实测 2026-10-10：行首 billing 整行 + 两句官方整句，只扫 system/assistant；整句为纯子串匹配）——

const CC_SENT = () => "You are Claude Code, Anthropic's official CLI for Claude.";

test("payload: strips billing line and identity sentence from system", () => {
  const sys = "x-anthropic-billing-header: cc_version=2.1.197.a4a; cc_entrypoint=cli;\nYou are Claude Code, Anthropic's official CLI for Claude.\nYou are an interactive agent.";
  const out = rewriteWorkbuddyPayload({ model: "glm-5.3-flash", messages: [{ role: "system", content: sys }, { role: "user", content: "hi" }] });
  assert.ok(!out.messages[0].content.includes("x-anthropic-billing-header"), "billing 行必须剥掉");
  assert.ok(!out.messages[0].content.includes(CC_SENT()), "身份整句必须剥掉");
  assert.ok(out.messages[0].content.includes("You are an interactive agent."), "用户侧正文必须保留");
});

test("payload: strips identity sentence echoed in assistant history", () => {
  const out = rewriteWorkbuddyPayload({ model: "glm-5.3-flash", messages: [
    { role: "user", content: "hi" },
    { role: "assistant", content: `You are Claude Code, Anthropic's official CLI for Claude. 很高兴帮你。` },
  ] });
  assert.equal(out.messages[1].content, " 很高兴帮你。");
});

test("payload: user/tool text is never touched (upstream does not scan those roles)", () => {
  const t = `日志里有 x-anthropic-billing-header: cc_version=1 和 ${CC_SENT()}`;
  const out = rewriteWorkbuddyPayload({ model: "glm-5.3-flash", messages: [
    { role: "user", content: t },
    { role: "tool", tool_call_id: "c1", content: t },
  ] });
  assert.equal(out.messages[0].content, t);
  assert.equal(out.messages[1].content, t);
});

test("payload: system content-array text parts also stripped without mutating original", () => {
  const src = { model: "glm-5.3-flash", messages: [{ role: "system", content: [{ type: "text", text: "x-anthropic-billing-header: cc_version=1;\nkeep me" }] }, { role: "user", content: "hi" }] };
  const out = rewriteWorkbuddyPayload(src);
  assert.equal(out.messages[0].content[0].text, "keep me");
  assert.ok(src.messages[0].content[0].text.includes("x-anthropic-billing-header"), "原对象不得被污染");
});

test("payload: strips the feedback-URL sentence too (bisected from real Claude Code 27KB system)", () => {
  const sys = "Some rules.\n- To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues\nMore text.";
  const out = rewriteWorkbuddyPayload({ model: "glm-5.3-flash", messages: [{ role: "system", content: sys }, { role: "user", content: "hi" }] });
  const t = out.messages[0].content;
  assert.ok(!t.includes("anthropics/claude-code"), "feedback 整句必须剥掉（实测整句纯子串匹配，与行首 - 前缀无关）");
  assert.ok(t.includes("Some rules.") && t.includes("More text."), "前后正文必须保留");
});

test("payload: bare URL or paraphrase is left alone (上游是整句匹配不是关键词)", () => {
  const t = "see https://github.com/anthropics/claude-code/issues and the Claude Code docs";
  const out = rewriteWorkbuddyPayload({ model: "glm-5.3-flash", messages: [{ role: "system", content: t }, { role: "user", content: "hi" }] });
  assert.equal(out.messages[0].content, t);
});
