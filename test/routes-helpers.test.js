// readBody 的 UTF-8 边界回归：多字节字符被 TCP 切块时不得变成 U+FFFD。
// 为什么单独立测：这是「每轮同一份历史、坏的位置还不一样」的根因 —— 坏字节随请求体转发给上游，
// 从坏点起的前缀每轮都变，上游前缀缓存永远命中不了（实测 ttft 19s ≈ 全量 prefill）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readBody } from "../src/routes/helpers.js";

// 极简 mock req：把预置的 chunk 序列在下一 tick 依次 emit（模拟 TCP 分片）
function mockReq(chunks) {
  const req = new EventEmitter();
  setImmediate(() => {
    for (const c of chunks) req.emit("data", c);
    req.emit("end");
  });
  return req;
}

test("readBody：汉字被切在两个 TCP 块中间时仍完整解码（不得出现 U+FFFD）", async () => {
  const json = JSON.stringify({ model: "m", messages: [{ role: "user", content: "这个模型额度没了" }] });
  const bytes = Buffer.from(json, "utf8");
  // 故意切在「个」的 3 个字节中间
  const at = bytes.indexOf(Buffer.from("个", "utf8")) + 1;
  const body = await readBody(mockReq([bytes.subarray(0, at), bytes.subarray(at)]));
  assert.equal(body.messages[0].content, "这个模型额度没了");
  assert.ok(!JSON.stringify(body).includes("\uFFFD"), "不得出现替换字符");
});

test("readBody：逐字节切块（最坏情况）仍完整解码", async () => {
  const json = JSON.stringify({ s: "中文测试🙂", tool: [{ content: "额度没了" }] });
  const bytes = Buffer.from(json, "utf8");
  const chunks = [];
  for (let i = 0; i < bytes.length; i++) chunks.push(bytes.subarray(i, i + 1));
  const body = await readBody(mockReq(chunks));
  assert.equal(body.s, "中文测试🙂");
  assert.ok(!JSON.stringify(body).includes("\uFFFD"));
});

test("readBody：空体给 {}；坏 JSON 仍 reject", async () => {
  assert.deepEqual(await readBody(mockReq([])), {});
  await assert.rejects(() => readBody(mockReq([Buffer.from("{坏")])), /JSON/);
});

test("readBody：字符串 chunk 也照收（测试桩/已 setEncoding 的调用方）", async () => {
  const body = await readBody(mockReq(['{"a":"中"', ',"b":1}']));
  assert.deepEqual(body, { a: "中", b: 1 });
});
