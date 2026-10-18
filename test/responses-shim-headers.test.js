// 外部审计报告（bug-list.md 附录 C）指出的垫片缺陷，每条都实测复核后修的回归锁。
// 核心契约：垫片的 headersSent / getHeader 必须真反映「头已发」，否则 helpers.json() 的
// 「已 flush 就走 in-band 错误帧」守卫永远判假 → 错误静默丢失，客户端只见裸关流。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLiveForwarder } from "../src/routes/responses-route.js";
import { createChunkTranslator } from "../src/responses/translate.js";

function fakeRealRes() {
  return {
    headersSent: false,
    chunks: [],
    ended: false,
    writeHead() { this.headersSent = true; },
    write(c) { this.chunks.push(String(c)); return true; },
    end() { this.ended = true; this.headersSent = true; },
  };
}

test("垫片 headersSent 在 write 之后即为真（旧版只在 end() 置真 ⇒ json() 守卫失效）", () => {
  const real = fakeRealRes();
  const shim = createLiveForwarder(real, createChunkTranslator("m"));
  assert.equal(shim.headersSent, false, "写之前未发头");
  shim.write(Buffer.from('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
  assert.equal(real.headersSent, true, "write 应真发头");
  assert.equal(shim.headersSent, true, "垫片必须同步反映「头已发」");
});

test("垫片 getHeader('content-type') 在发头后报 text/event-stream（json() 靠它分流）", () => {
  const real = fakeRealRes();
  const shim = createLiveForwarder(real, createChunkTranslator("m"));
  assert.equal(shim.getHeader("content-type"), undefined, "未发头时不得谎报");
  shim.write(Buffer.from('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
  assert.equal(shim.getHeader("content-type"), "text/event-stream");
  assert.equal(shim.getHeader("Content-Type"), "text/event-stream", "大小写不敏感");
});

test("头已发后 json() 走 in-band 错误帧 + [DONE]，不静默关流", async () => {
  const real = fakeRealRes();
  const shim = createLiveForwarder(real, createChunkTranslator("m"));
  shim.write(Buffer.from('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n'));
  const { json } = await import("../src/routes/helpers.js");
  json(shim, 502, { error: { message: "boom" } });
  const out = real.chunks.join("");
  assert.ok(out.includes("mslxdff_error"), "必须写出 in-band 错误帧");
  assert.ok(out.includes("data: [DONE]"), "必须补终止符");
  assert.ok(real.ended, "必须关流");
});
