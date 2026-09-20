import test from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { createInterface, nodeMajor, assertChatNode } from "../src/readline-compat.js";

function devNull() {
  return new Writable({ write(_c, _e, cb) { cb(); } });
}

test("question 包成 Promise：resolve 输入行", async () => {
  const rl = createInterface({ input: Readable.from(["hi\n"]), output: devNull(), terminal: false });
  const ans = await rl.question(">");
  assert.equal(ans, "hi");
  rl.close();
});

test("for await 逐行可读 + prompt 可调（repl 用法）", async () => {
  const rl = createInterface({ input: Readable.from(["a\n", "b\n"]), output: devNull(), terminal: false });
  rl.prompt();
  const got = [];
  for await (const line of rl) got.push(line);
  assert.deepEqual(got, ["a", "b"]);
  rl.close();
});

test("本机 Node 通过版本门", () => {
  assert.ok(nodeMajor() >= 18);
  assert.equal(assertChatNode(), true);
});
