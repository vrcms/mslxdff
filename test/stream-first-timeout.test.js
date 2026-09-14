import { test } from "node:test";
import assert from "node:assert/strict";
import { relay } from "../src/routes/stream.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeRes() {
  const res = {
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
  return res;
}

function sseChunk(obj) {
  return Buffer.from(`data: ${JSON.stringify(obj)}\n\n`, "utf8");
}

function upResWith(body) {
  return {
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body,
  };
}

test("首块晚于闸门但最终到达：撤销超时判定，数据照常转发（不判死）", async () => {
  const res = fakeRes();
  // 模拟 muse-spark：思考 120ms（> 闸门 50ms）后才吐首块；cancel 是协作式的，缓冲数据仍会到达
  const body = {
    async *[Symbol.asyncIterator]() {
      await sleep(120);
      yield sseChunk({ choices: [{ delta: { content: "你好" } }] });
      yield Buffer.from("data: [DONE]\n\n");
    },
    cancel() {},
  };
  const r = await relay(res, upResWith(body), { stream: true }, { streamTimeoutMs: 50 });
  assert.equal(r.status, 200);
  assert.ok(r.detail.wroteChunks >= 1, "数据必须被写出，不能因闸门触发而丢弃");
  assert.ok(r.detail.chars >= 2, "chars 应统计到");
  assert.equal(r.detail.sawDone, true);
  assert.equal(r.detail.exitReason, "normal");
  assert.equal(r.detail.recoveries, 1, "应记录一次超时救回");
  assert.ok(res.wrote.join("").includes("你好"));
});

test("上游真死（闸门内无任何数据、cancel 后流结束）：按首块超时返回，不写数据", async () => {
  const res = fakeRes();
  let cancelled = false;
  const body = {
    async *[Symbol.asyncIterator]() {
      await sleep(200);
      if (!cancelled) yield sseChunk({ choices: [{ delta: { content: "不该出现" } }] });
    },
    cancel() { cancelled = true; },
  };
  const r = await relay(res, upResWith(body), { stream: true }, { streamTimeoutMs: 50 });
  assert.equal(r.status, 50, "闸门值原样作为超时状态返回（供上层 failover 判定）");
  assert.equal(r.detail.wroteChunks, 0);
  assert.equal(res.wrote.length, 0);
});

test("streamTimeoutMs=0：显式关闭首块超时，慢上游不再判死", async () => {
  const res = fakeRes();
  const body = {
    async *[Symbol.asyncIterator]() {
      await sleep(150);
      yield sseChunk({ choices: [{ delta: { content: "ok" } }] });
      yield Buffer.from("data: [DONE]\n\n");
    },
    cancel() {},
  };
  const r = await relay(res, upResWith(body), { stream: true }, { streamTimeoutMs: 0 });
  assert.equal(r.status, 200);
  assert.ok(r.detail.wroteChunks >= 1);
  assert.equal(r.detail.exitReason, "normal");
});
