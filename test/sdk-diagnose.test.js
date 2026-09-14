import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnoseToolSequence, compactSequence } from "../src/upstream-engine/sdk/diagnose.js";

const A = (calls) => ({ role: "assistant", content: "", tool_calls: calls.map((id) => ({ id, type: "function", function: { name: "t", arguments: "{}" } })) });
const T = (id) => ({ role: "tool", tool_call_id: id, content: "r" });
const U = { role: "user", content: "hi" };

test("正常配对：U A{c1} T{c1} A 无 issues", () => {
  const { issues, summary } = diagnoseToolSequence([U, A(["c1"]), T("c1"), A([])]);
  assert.deepEqual(issues, []);
  assert.match(summary, /msgs=4 calls=1 results=1/);
});

test("多调用配对：A{c1,c2} T{c1} T{c2} 无 issues；并行调用仅部分结果也合法", () => {
  assert.deepEqual(diagnoseToolSequence([U, A(["c1", "c2"]), T("c1"), T("c2")]).issues, []);
  assert.deepEqual(diagnoseToolSequence([U, A(["c1", "c2"]), T("c2"), T("c1")]).issues, []);
});

test("首条为带工具的 assistant 报出（上游拒 tool call 无前置上下文）", () => {
  const { issues } = diagnoseToolSequence([A(["c1"]), T("c1")]);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /#0 首条为 assistant/);
});

test("孤立结果（无对应调用）报出", () => {
  const { issues } = diagnoseToolSequence([U, T("x"), U]);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /#1 孤立结果:x/);
});

test("悬空调用（无结果）报出", () => {
  const { issues } = diagnoseToolSequence([U, A(["c9"])]);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /#1 悬空调用:c9/);
});

test("配对被打断：A{c1} → user → T{c1} 报出打断", () => {
  const { issues } = diagnoseToolSequence([U, A(["c1"]), U, T("c1")]);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /#2 user 打断\{c1\}/);
});

test("配对被打断：A{c1} → assistant(无调用) → T{c1} 报出打断", () => {
  const { issues } = diagnoseToolSequence([U, A(["c1"]), A([]), T("c1")]);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /#2 assistant\(无调用\) 打断\{c1\}/);
});

test("配对被打断：A{c1} → A{c2} T{c1} T{c2} 报出 assistant 打断", () => {
  const { issues } = diagnoseToolSequence([U, A(["c1"]), A(["c2"]), T("c1"), T("c2")]);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /#2 assistant 打断未闭合\{c1\}/);
});

test("重复 call id 报出", () => {
  const { issues } = diagnoseToolSequence([U, A(["c1", "c1"]), T("c1")]);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /#1 call id 重复:c1/);
});

test("空 id 报出（AI SDK 占位空串的上游后果）", () => {
  const { issues } = diagnoseToolSequence([U, A([""]), T("")]);
  assert.equal(issues.length, 2);
  assert.match(issues[0], /tool_call 空 id/);
  assert.match(issues[1], /tool 结果空 id/);
});

test("compactSequence 输出紧凑序列、下标窗口与 limit", () => {
  const msgs = [U, A(["c1"]), T("c1"), A([])];
  assert.equal(compactSequence(msgs), "U A{c1} T{c1} A");
  assert.equal(compactSequence(msgs, 2), "T{c1} A");
  assert.equal(compactSequence(msgs, 0, 2), "U A{c1}");
  assert.equal(compactSequence(msgs, 99), "");
});
