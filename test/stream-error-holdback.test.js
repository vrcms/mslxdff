import { test } from "node:test";
import assert from "node:assert/strict";
import { relay } from "../src/routes/stream.js";

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

function upResWith(chunks) {
  return {
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: {
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield c;
      },
      cancel() {},
    },
  };
}

// 网关 200 包错误（Vertex 503 + google fallback 400）的真实形状
const ERR_ENVELOPE = { error: { message: "Failed to create stream: request failed with status 400", code: "stream_initialization_failed" } };
const ERR_TAIL = { id: "chatcmpl-wb-sdk", object: "chat.completion.chunk", created: 1, model: "", choices: [{ index: 0, delta: {}, finish_reason: "error" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };

test("纯错误轮：错误包络暂扣，下游看不到 400 原文", async () => {
  const res = fakeRes();
  const r = await relay(res, upResWith([sseChunk(ERR_ENVELOPE), sseChunk(ERR_TAIL), Buffer.from("data: [DONE]\n\n")]), { stream: true, model: "cline/cline-free/gemini-3.8-flash" }, { streamTimeoutMs: 5000 });
  const out = res.wrote.join("");
  assert.ok(!out.includes("Failed to create stream"), "错误原文不得写下游");
  assert.ok(!out.includes("400"), "400 不得写下游");
  assert.equal(r.detail.wroteChunks, 1, "只写出 DONE 终止帧（错误帧不计写出）");
  assert.ok(out.includes("[DONE]"), "DONE 终止帧必须照常发出");
  assert.equal(r.detail.heldErrorChunks, 2, "两帧错误都暂扣");
  assert.ok(String(r.detail.upstreamErrorText).includes("Failed to create stream"), "摘要留 detail 供排障");
  assert.equal(r.detail.sawFinishReason, "error", "结束原因照常识别（供空转判定）");
  assert.equal(r.status, 200, "relay 层仍 200（转不转 502 由 pipeline 空转门决定）");
});

test("混合轮：真实内容照常透传（开转后不再暂扣）", async () => {
  const res = fakeRes();
  const r = await relay(res, upResWith([
    sseChunk({ choices: [{ delta: { role: "assistant" } }] }),
    sseChunk({ choices: [{ delta: { content: "hello" } }] }),
    sseChunk(ERR_TAIL),
    Buffer.from("data: [DONE]\n\n"),
  ]), { stream: true, model: "m" }, { streamTimeoutMs: 5000 });
  const out = res.wrote.join("");
  assert.ok(out.includes("hello"), "真实内容必须透传");
  assert.equal(r.detail.heldErrorChunks || 0, 0, "已开转的轮不再暂扣（错误帧随内容透传）");
  assert.ok(r.detail.chars > 0, "chars 照常统计");
});
test("错误包络在真实内容之后：照常透传（不暂扣已开转的轮）", async () => {
  const res = fakeRes();
  await relay(res, upResWith([
    sseChunk({ choices: [{ delta: { content: "hi" } }] }),
    sseChunk(ERR_ENVELOPE),
    Buffer.from("data: [DONE]\n\n"),
  ]), { stream: true, model: "m" }, { streamTimeoutMs: 5000 });
  const out = res.wrote.join("");
  assert.ok(out.includes("Failed to create stream"), "已写出真实内容后错误帧照常透传");
});

test("坏 JSON chunk：默认透传保安全", async () => {
  const res = fakeRes();
  const r = await relay(res, upResWith([
    Buffer.from('data: {"error": broken json\n\n'),
    Buffer.from("data: [DONE]\n\n"),
  ]), { stream: true, model: "m" }, { streamTimeoutMs: 5000 });
  assert.ok(res.wrote.join("").includes("broken json"), "解析失败不得暂扣");
  assert.equal(r.detail.heldErrorChunks || 0, 0);
});
