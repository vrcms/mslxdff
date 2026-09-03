import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../src/chat/engine.js";

function fakeChatFactory(responses) {
  let i = 0;
  return async ({ messages, tools }) => {
    const r = responses[i++] || responses[responses.length - 1];
    if (typeof r === "function") return r({ messages, tools });
    return r;
  };
}

test("engine: 单轮无工具直接返回文本", async () => {
  const chat = fakeChatFactory([{ ok: true, message: { content: "hello" }, model: "m", usage: { prompt_tokens: 1, completion_tokens: 2 } }]);
  const engine = createEngine({ chatWithFallback: chat, summarizeHistory: async () => null, getToolDefs: () => [] });
  const messages = [{ role: "system", content: "sys" }];
  const r = await engine.runTurn("hi", messages);
  assert.equal(r.ok, true);
  assert.match(r.text, /hello/);
  assert.equal(r.model, "m");
});

test("engine: 工具去重 run_command 第二次 SKIP", async () => {
  let execCalls = 0;
  const execCommand = async (cmd) => { execCalls++; return { ok: true, output: `out:${cmd}` }; };
  const chat = fakeChatFactory([
    { ok: true, message: { content: "", tool_calls: [{ id: "1", function: { name: "run_command", arguments: JSON.stringify({ command: "-status" }) } }] }, model: "m" },
    { ok: true, message: { content: "done" }, model: "m" },
  ]);
  const engine = createEngine({ chatWithFallback: chat, execCommand, summarizeHistory: async () => null, getToolDefs: () => [{ function: { name: "run_command" } }] });
  const messages = [{ role: "system", content: "sys" }];
  // first turn will execute -status, second loop will get done
  const r = await engine.runTurn("查状态", messages);
  assert.equal(execCalls, 1);
  // now simulate duplicate within same turn: need 2 tool_calls same command in one LLM response
  let exec2 = 0;
  const chatDup = fakeChatFactory([
    { ok: true, message: { content: "", tool_calls: [
      { id: "a", function: { name: "run_command", arguments: JSON.stringify({ command: "-status" }) } },
      { id: "b", function: { name: "run_command", arguments: JSON.stringify({ command: "-status" }) } },
    ] }, model: "m" },
    { ok: true, message: { content: "done2" }, model: "m" },
  ]);
  const engineDup = createEngine({ chatWithFallback: chatDup, execCommand: async () => { exec2++; return { ok: true, output: "ok" }; }, summarizeHistory: async () => null, getToolDefs: () => [{ function: { name: "run_command" } }] });
  const r2 = await engineDup.runTurn("again", [{ role: "system", content: "sys" }]);
  assert.equal(exec2, 1, "duplicate run_command should be skipped");
  assert.ok(r2.ok);
});

test("engine: maybeCompress 超阈值会调用 summarizeHistory", async () => {
  let summarized = false;
  const summarizeHistory = async () => { summarized = true; return "【历史摘要】xxx"; };
  const chat = fakeChatFactory([{ ok: true, message: { content: "hi" }, model: "m" }]);
  const engine = createEngine({ chatWithFallback: chat, summarizeHistory, getToolDefs: () => [] });
  // build long messages to trigger needsCompress: estimateChars >400000 and rest >42
  const longContent = "a".repeat(25000);
  const messages = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 50; i++) messages.push({ role: "user", content: longContent });
  const out = await engine.maybeCompress(messages);
  assert.ok(summarized, "should call summarizeHistory when over threshold and enough messages");
  assert.ok(out.length < messages.length, "should compress");
});

test("engine: 去重键归一 -providers vs -provider", async () => {
  let cmds = [];
  const execCommand = async (cmd) => { cmds.push(cmd); return { ok: true, output: "ok" }; };
  const chat = fakeChatFactory([
    { ok: true, message: { content: "", tool_calls: [
      { id: "1", function: { name: "run_command", arguments: JSON.stringify({ command: "-providers list" }) } },
      { id: "2", function: { name: "run_command", arguments: JSON.stringify({ command: "-provider list" }) } },
    ] }, model: "m" },
    { ok: true, message: { content: "done" }, model: "m" },
  ]);
  const engine = createEngine({ chatWithFallback: chat, execCommand, summarizeHistory: async () => null, getToolDefs: () => [{ function: { name: "run_command" } }] });
  await engine.runTurn("x", [{ role: "system", content: "sys" }]);
  assert.equal(cmds.length, 1, "-providers and -provider should be deduped");
});
