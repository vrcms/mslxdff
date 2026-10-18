// BUG-17：中断的长流旧代码只补 `[DONE]` 就按 200 成功返回 —— 客户端既无错误帧也无 finish_reason，
// 分不出「答完了」与「被腰斩」，会把半截回答当完整结果用（比报错更危险）。
// MAX_STREAM_MS / STALL_TIMEOUT_MS 是**模块级常量（import 时读 env）**，故本文件独立、且在 import 前设 env
// —— 见 test/AGENTS.md「要覆盖就新建独立测试文件」。
process.env.MSLXDFF_MAX_STREAM_MS = "80";
process.env.MSLXDFF_KEEPALIVE_MS = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
// 必须动态导入：静态 import 会被提升到 env 赋值之前（ESM 语义），env 就白设了
const { relay } = await import("../src/routes/stream.js");

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

const sseChunk = (obj) => Buffer.from(`data: ${JSON.stringify(obj)}\n\n`, "utf8");
const upResWith = (body) => ({ status: 200, headers: new Headers({ "content-type": "text/event-stream" }), body });

test("总时长到点且上游从未给 finish_reason：补 SSE 错误帧（排在 [DONE] 前），标记 truncated", async () => {
  const res = fakeRes();
  const body = {
    // 一直吐正文、永不给 finish_reason、永不结束 —— 300s 腰斩长流的缩影
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < 100; i++) {
        yield sseChunk({ choices: [{ index: 0, delta: { content: "字" } }] });
        await sleep(10);
      }
    },
    cancel() {},
  };
  const r = await relay(res, upResWith(body), { stream: true });
  assert.equal(r.truncated, true, "必须标记截断");
  assert.equal(r.detail.exitReason, "truncated");
  const out = res.wrote.join("");
  assert.ok(out.includes("STREAM_TRUNCATED"), "客户端必须收到截断错误帧");
  assert.ok(out.includes('"type":"mslxdff_truncated"'), "错误帧须带可区分的 type");
  // 次序铁律：错误帧必须排在 [DONE] 之前
  const atErr = out.indexOf("STREAM_TRUNCATED");
  const atDone = out.indexOf("data: [DONE]");
  assert.ok(atDone === -1 || atErr < atDone, "[DONE] 不得排在错误帧之前");
  assert.ok(res.ended, "必须收场");
});

test("`[DONE]` 与正文挤在同一个 chunk：仍须扣住 [DONE]、错误帧排在它之前、终止符恰好一个", async () => {
  // 网络 chunk 边界与 SSE 帧边界无关：上游常把末个内容帧与 data: [DONE] 一次 flush 送进同一个 chunk。
  // 这种帧若整体直写，[DONE] 就抢在错误帧之前（客户端一见 [DONE] 即收尾 ⇒ 静默截断），且收场会补出第二个。
  const res = fakeRes();
  const body = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "半个回答" } }] })}\n\ndata: [DONE]\n\n`,
        "utf8",
      );
      await sleep(200);
    },
    cancel() {},
  };
  const r = await relay(res, upResWith(body), { stream: true });
  assert.equal(r.truncated, true);
  assert.equal(r.detail.sawDone, true, "上游确实发过 [DONE]");
  const out = res.wrote.join("");
  assert.equal((out.match(/data: \[DONE\]/g) || []).length, 1, "终止符只能有一个");
  assert.ok(out.indexOf("STREAM_TRUNCATED") < out.indexOf("data: [DONE]"), "错误帧必须先于 [DONE]");
  assert.ok(out.includes("半个回答"), "正文不得因切分而损坏");
});

test("正文里出现字面量 [DONE]（非终止帧行）不得被误切", async () => {
  const res = fakeRes();
  const content = 'SSE 以 data: [DONE] 结束这段传输，中间出现 [DONE] 字样属正常';
  const body = {
    async *[Symbol.asyncIterator]() {
      yield sseChunk({ choices: [{ index: 0, delta: { content } }] });
      await sleep(200);
    },
    cancel() {},
  };
  const r = await relay(res, upResWith(body), { stream: true });
  assert.equal(r.truncated, true);
  const out = res.wrote.join("");
  assert.ok(out.includes(JSON.stringify(content).slice(1, -1).slice(0, 20)), "正文不得被切坏");
  assert.equal((out.match(/(?:^|\n)data: \[DONE\]\r?(?=\n|$)/g) || []).length, 1, "终止符只能有一个");
});

test("HOLD_END=0（关留口）下 [DONE] 已直写：收场也不得补出第二个终止符", async () => {
  // holdEndEnabled() 在调用时读 env（模块级常量才需独立文件），故此处可per-test 覆盖并还原
  process.env.MSLXDFF_EMPTY_TURN_HOLD_END = "0";
  try {
    const res = fakeRes();
    const body = {
      async *[Symbol.asyncIterator]() {
        yield sseChunk({ choices: [{ index: 0, delta: { content: "半个回答" } }] });
        yield Buffer.from("data: [DONE]\n\n", "utf8");
        await sleep(200);
      },
      cancel() {},
    };
    const r = await relay(res, upResWith(body), { stream: true });
    assert.equal(r.truncated, true);
    const out = res.wrote.join("");
    assert.equal((out.match(/data: \[DONE\]/g) || []).length, 1, "终止符只能有一个");
    assert.ok(out.indexOf("STREAM_TRUNCATED") < out.indexOf("data: [DONE]"), "错误帧必须先于 [DONE]");
  } finally {
    delete process.env.MSLXDFF_EMPTY_TURN_HOLD_END;
  }
});

// BUG-27：截断收场的两条 return 原先既不置 finishedNormally、也不摘 close 监听。
// 真 Node 里 res.end() 之后 socket 关闭会触发 'close' ⇒ onClose 把这次**服务端主动掐断**
// 当成「下游断开」执行 ⇒ 上层记一条 client-abort（`format.js` 渲染成「client abort」），
// 归因到了客户端身上。实测对照：正常收场监听=0 / 截断收场监听=1。
test("截断收场不得把自己记成 client-abort：close 监听必须摘掉", async () => {
  const res = fakeRes();
  let aborts = 0;
  const body = {
    async *[Symbol.asyncIterator]() {
      yield sseChunk({ choices: [{ index: 0, delta: { content: "半个回答" } }] });
      await sleep(200); // 超过 MAX_STREAM_MS=80 ⇒ 服务端主动截断收场
    },
    cancel() {},
  };
  const r = await relay(res, upResWith(body), { stream: true }, { onDownstreamAbort: () => { aborts += 1; } });
  assert.equal(r.truncated, true);
  assert.equal((res._handlers.close || []).length, 0, "收场后 close 监听必须为空");
  res.emit("close"); // 模拟真 Node：end() 之后触发的一次 close
  assert.equal(aborts, 0, "服务端主动截断不得被当成客户端断开");
  assert.equal(r.detail.downstreamClosed, false, "detail 也不得被标记成下游已断");
});

test("上游正常给了 finish_reason 再断：不算截断，照旧补 [DONE] 不插错误帧", async () => {
  const res = fakeRes();
  const body = {
    async *[Symbol.asyncIterator]() {
      yield sseChunk({ choices: [{ index: 0, delta: { content: "完整回答" } }] });
      yield sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      // 卡住直到总时长闸门触发（已交代结局 ⇒ 不该被当成截断）
      await sleep(200);
    },
    cancel() {},
  };
  const r = await relay(res, upResWith(body), { stream: true });
  assert.equal(r.truncated, undefined, "有 finish_reason 就不是截断");
  assert.ok(!res.wrote.join("").includes("STREAM_TRUNCATED"));
});
