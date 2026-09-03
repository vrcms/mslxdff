import { test, describe } from "node:test";
import assert from "node:assert/strict";

// 红阶段：模块尚不存在，应报 MODULE_NOT_FOUND
import { buildDedupKey, runTool } from "../src/chat/tool-handlers.js";

describe("chat tool-handlers 拆分", () => {
  test("US1 去重键归一：大小写/空白/-providers", () => {
    const a = buildDedupKey("run_command", { command: "-Providers  LIST" });
    const b = buildDedupKey("run_command", { command: "-provider list" });
    assert.equal(a, b);
    const c = buildDedupKey("curl", { url: "HTTP://X/Y", method: "get", body: "" });
    const d = buildDedupKey("curl", { url: "http://x/y", method: "GET", body: "" });
    assert.equal(c, d);
    const e = buildDedupKey("read_file", { path: "SRC/A.js" });
    const f = buildDedupKey("read_file", { path: "src/a.js" });
    assert.equal(e, f);
  });

  test("US2 run_command 成功带 once-and-done 提示", async () => {
    const traces = [];
    const out = await runTool({
      name: "run_command",
      args: { command: "-status" },
      userText: "查状态",
      execCommand: async () => ({ ok: true, output: "ok-out" }),
      onTrace: (t) => traces.push(t),
    });
    assert.match(out, /^OK: ok-out/);
    assert.match(out, /直接用中文回答用户/);
  });

  test("US3 问模型时 provider list 给纠偏提示", async () => {
    const out = await runTool({
      name: "run_command",
      args: { command: "-provider list" },
      userText: "有哪些模型",
      execCommand: async () => ({ ok: true, output: "providers" }),
      onTrace: () => {},
    });
    assert.match(out, /仅显示供应商配置/);
  });

  test("US4 unknown tool 原样返回", async () => {
    const out = await runTool({ name: "nope", args: {}, userText: "", onTrace: () => {} });
    assert.equal(out, "unknown tool nope");
  });
});
