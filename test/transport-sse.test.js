import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSseParser, parseSseChunk } from "../src/transport/sse.js";

describe("transport/sse - SseParser", () => {
  it("单帧 data: hello", () => {
    const p = createSseParser();
    const ev = p.push("data: hello\n\n");
    assert.deepEqual(ev, ["hello"]);
  });
  it("多行 data 拼接", () => {
    const p = createSseParser();
    const ev = p.push("data: foo\n" + "data: bar\n" + "\n");
    assert.deepEqual(ev, ["foo\nbar"]);
  });
  it("注释 : 跳过", () => {
    const p = createSseParser();
    const ev = p.push(": keepalive\n" + "data: hi\n\n");
    assert.deepEqual(ev, ["hi"]);
  });
  it("[DONE] 透传为事件", () => {
    const p = createSseParser();
    const ev = p.push("data: [DONE]\n\n");
    assert.deepEqual(ev, ["[DONE]"]);
  });
  it("粘包 remain 处理：半包等下一 push", () => {
    const p = createSseParser();
    let ev = p.push("data: hel");
    assert.deepEqual(ev, []);
    ev = p.push("lo\n\n");
    assert.deepEqual(ev, ["hello"]);
  });
  it("多帧一次 push", () => {
    const p = createSseParser();
    const ev = p.push("data: a\n\n" + "data: b\n\n");
    assert.deepEqual(ev, ["a", "b"]);
  });
  it("data: 无空格兼容", () => {
    const p = createSseParser();
    const ev = p.push("data:hello\n\n");
    assert.deepEqual(ev, ["hello"]);
  });
  it("空 data: 产生空字符串事件(被调用方过滤)", () => {
    const p = createSseParser();
    const ev = p.push("data: \n\n");
    assert.deepEqual(ev, [""]);
  });
  it("parseSseChunk 纯函数", () => {
    const { events, remain } = parseSseChunk("data: a\n\n" + "data: b");
    assert.deepEqual(events, ["a"]);
    assert.equal(remain, "data: b");
  });
  it("flush 刷出残留无换行", () => {
    const p = createSseParser();
    p.push("data: tail");
    const ev = p.flush();
    // 残留未形成完整帧，不应误发；或按实现 flush 空
    assert.deepEqual(ev, []);
  });
});
