import { test } from "node:test";
import assert from "node:assert/strict";
import { handleSlash, SLASH_HELP } from "../src/chat/terminal.js";

test("terminal: /help 返回帮助", () => {
  const ctx = { messages: [{ role: "system", content: "sys" }], system: "sys" };
  const r = handleSlash("/help", ctx);
  assert.equal(r.handled, true);
  assert.ok(SLASH_HELP.includes("/help"));
});

test("terminal: /clear 清空历史", () => {
  const ctx = { messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }], system: "sys" };
  const r = handleSlash("/clear", ctx);
  assert.equal(r.handled, true);
  assert.ok(r.messages);
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].role, "system");
});

test("terminal: /history handled", () => {
  const ctx = { messages: [{ role: "system", content: "sys" }, { role: "user", content: "hello world this is a test" }], system: "sys" };
  const r = handleSlash("/history", ctx);
  assert.equal(r.handled, true);
});

test("terminal: 未知命令不处理", () => {
  const ctx = { messages: [], system: "sys" };
  const r = handleSlash("hello world", ctx);
  assert.equal(r.handled, false);
});

test("terminal: /exit 标记退出", () => {
  const ctx = { messages: [], system: "sys" };
  const r = handleSlash("/exit", ctx);
  assert.equal(r.handled, true);
  assert.equal(r.exit, true);
});
