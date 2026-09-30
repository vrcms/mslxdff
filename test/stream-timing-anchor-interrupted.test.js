import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

// 本文件独立存在的原因：MAX_STREAM_MS 是模块级常量（import 时读 env），
// node --test 每个文件独立进程 → 在这里设上限只影响本文件，不污染其它锚点用例。
process.env.MSLXDFF_MAX_STREAM_MS = "120";
const { relay } = await import("../src/routes/stream.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    wrote: [],
    ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = String(v); },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    write(c) { this.wrote.push(Buffer.isBuffer(c) ? c.toString("utf8") : String(c)); return true; },
    end() { this.ended = true; },
    on() { return this; },
    removeListener() { return this; },
  };
}

test("中断返回点也带锚点偏移：max 流时长掐断后仍报得出真实等待", async () => {
  const res = fakeRes();
  const chunk = Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: "先出字" } }] })}\n\n`, "utf8");
  const body = {
    async *[Symbol.asyncIterator]() {
      yield chunk;          // 先落一个真实载荷 → wrotePayload=true，走中断而非超时
      await sleep(300);     // 跨过 MAX_STREAM_MS=120
      yield Buffer.from("data: [DONE]\n\n");
    },
    cancel() {},
  };
  const upRes = { status: 200, headers: new Headers({ "content-type": "text/event-stream" }), body };
  const attemptStartMs = performance.now() - 6_000;
  const r = await relay(res, upRes, { stream: true }, { attemptStartMs });
  assert.equal(r.interrupted, true, "应命中 max 中断分支");
  assert.ok(r.preflightMs >= 6_000 && r.preflightMs < 6_500, `中断分支也必须带偏移，实得 ${r.preflightMs}`);
  assert.ok(r.ttfMs != null && r.ttfMs < 500, `ttf 仍是转发入口相对（实得 ${r.ttfMs}ms）`);
});
