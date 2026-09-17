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
    _handlers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = String(v); },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    write(c) { this.wrote.push(Buffer.isBuffer(c) ? c.toString("utf8") : String(c)); return true; },
    end(c) { this.ended = true; if (c != null) this.wrote.push(String(c)); },
    on(k, fn) { (this._handlers[k] ??= []).push(fn); return this; },
    removeListener(k, fn) { const a = this._handlers[k]; if (a) this._handlers[k] = a.filter((f) => f !== fn); return this; },
    emit(k, ...args) { for (const f of [...(this._handlers[k] || [])]) f(...args); },
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
  assert.equal(r.timedOut, false, "救回后不再是超时");
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
  assert.equal(r.timedOut, true, "超时是显式字段（status 数值不再是信号）");
  assert.equal(r.status, 504, "status 回归 HTTP 语义");
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
  assert.equal(r.timedOut, false);
  assert.ok(r.detail.wroteChunks >= 1);
  assert.equal(r.detail.exitReason, "normal");
});

test("流式 usage 归一化：reasoning_tokens 透传（口径收口 metrics.js）", async () => {
  const res = fakeRes();
  const body = {
    async *[Symbol.asyncIterator]() {
      yield sseChunk({ choices: [{ delta: { content: "hi" } }] });
      yield sseChunk({ choices: [{ finish_reason: "stop", delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8, completion_tokens_details: { reasoning_tokens: 2 } } });
      yield Buffer.from("data: [DONE]\n\n");
    },
    cancel() {},
  };
  const r = await relay(res, upResWith(body), { stream: true }, { streamTimeoutMs: 0 });
  assert.equal(r.detail.usage?.completion_tokens, 5);
  assert.equal(r.detail.usage?.reasoning_tokens, 2, "旧内联实现会丢 reasoning_tokens");
  assert.ok(r.detail.chars >= 2);
});

test("非流式但上游给的是 SSE 文本：仍能提出 usage（此前直接丢）", async () => {
  const res = fakeRes();
  const sseText = [
    'data: {"choices":[{"delta":{"content":"hi"}}]}',
    "",
    'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":7,"total_tokens":10}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const upRes = {
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    text: async () => sseText,
  };
  const r = await relay(res, upRes, { stream: false }, { streamTimeoutMs: 0 });
  assert.equal(r.timedOut, false);
  assert.equal(r.detail.usage?.completion_tokens, 7, "非流式 SSE 文本应走 extractUsageFromSseText 兜底");
  assert.equal(r.detail.chars, sseText.length);
});

test("等首块期间发 SSE 心跳帧（客户端不误判卡死）", async () => {
  const res = fakeRes();
  const body = {
    async *[Symbol.asyncIterator]() {
      await sleep(120);
      yield sseChunk({ choices: [{ delta: { content: "你好" } }] });
      yield Buffer.from("data: [DONE]\n\n");
    },
    cancel() {},
  };
  const r = await relay(res, upResWith(body), { stream: true }, { streamTimeoutMs: 0, keepaliveMs: 30 });
  const joined = res.wrote.join("");
  assert.ok(joined.includes(": keepalive"), "等待期间应有心跳帧");
  assert.ok(joined.includes("你好"), "正文照常转发");
  assert.equal(r.status, 200);
});

// 真实 undici ReadableStream 形态：getReader() 锁定 + reader.cancel() 才有效；
// 顶层 body.cancel() 在锁定后必 reject（P0-2 根因，旧测试的假 body 掩盖了这一点）。
function hangingReaderBody({ onCancel } = {}) {
  let resolvePending = null;
  let cancelled = false;
  const reader = {
    read() {
      if (cancelled) return Promise.resolve({ done: true, value: undefined });
      return new Promise((r) => { resolvePending = r; });
    },
    cancel() {
      cancelled = true;
      onCancel?.();
      resolvePending?.({ done: true, value: undefined });
      return Promise.resolve();
    },
  };
  return { getReader: () => reader, cancel: () => reader.cancel(), locked: false };
}

function commentStreamBody({ intervalMs = 15, onCancel } = {}) {
  let timer = null;
  let cancelled = false;
  let resolvePending = null;
  const reader = {
    read() {
      if (cancelled) return Promise.resolve({ done: true, value: undefined });
      return new Promise((resolve) => {
        resolvePending = resolve;
        timer = setTimeout(() => resolve({ done: false, value: Buffer.from(": keepalive\n\n", "utf8") }), intervalMs);
      });
    },
    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
      onCancel?.();
      resolvePending?.({ done: true, value: undefined });
      return Promise.resolve();
    },
  };
  return { getReader: () => reader, cancel: () => reader.cancel() };
}

test("真实 reader 形态：闸门到点 reader.cancel() 真生效 → 立即 504，不再等 bodyTimeout", async () => {
  const res = fakeRes();
  let cancelled = 0;
  const body = hangingReaderBody({ onCancel: () => { cancelled += 1; } });
  const t0 = Date.now();
  const r = await relay(res, upResWith(body), { stream: true }, { streamTimeoutMs: 50, keepaliveMs: 0 });
  const ms = Date.now() - t0;
  assert.equal(r.timedOut, true, "闸门到点必须判超时（旧实现 cancel 空操作 → 永挂）");
  assert.equal(r.status, 504);
  assert.equal(r.detail.wroteChunks, 0);
  assert.equal(cancelled, 1, "必须真掐上游读");
  assert.ok(ms < 1500, `闸门到点应立即收场，实测 ${ms}ms`);
  assert.equal(res.wrote.length, 0);
});

test("keepalive 注释帧不算首块：不解除闸门、不触发救回，照常透传", async () => {
  const res = fakeRes();
  let cancelled = 0;
  const body = commentStreamBody({ intervalMs: 15, onCancel: () => { cancelled += 1; } });
  const r = await relay(res, upResWith(body), { stream: true }, { streamTimeoutMs: 70, keepaliveMs: 0 });
  assert.equal(r.timedOut, true, "注释帧不得解除闸门");
  assert.equal(r.status, 504);
  assert.equal(r.detail.recoveries, 0, "注释帧不得触发超时救回");
  assert.ok(r.detail.wroteChunks >= 1, "注释帧照常透传（客户端连接保活）");
  assert.ok(res.wrote.join("").includes(": keepalive"));
  assert.equal(cancelled, 1);
  // 已写过注释帧 → headers 已发；此时 failover 收尾（json）不能再 setHeader，否则抛 ERR_HTTP_HEADERS_SENT
  res.headersSent = true;
  const { json } = await import("../src/routes/helpers.js");
  json(res, 502, { error: "terminated" });
  assert.ok(res.wrote.join("").includes("terminated"), "failover 收尾不得因 headers 已发而抛错");
});

test("客户端断开：立即取消上游读（不再空转读完）", async () => {
  const res = fakeRes();
  let cancelled = 0;
  const body = hangingReaderBody({ onCancel: () => { cancelled += 1; } });
  const p = relay(res, upResWith(body), { stream: true }, { streamTimeoutMs: 0, keepaliveMs: 0 });
  await sleep(30);
  res.emit("close");
  const r = await p;
  assert.equal(cancelled, 1, "断开即掐上游");
  assert.equal(r.detail.downstreamClosed, true);
});
