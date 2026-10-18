// BUG-25：BUG-24 的行锚定只覆盖「完整终止帧与正文同 chunk」，覆盖不了**终止帧自己被 TCP 切开**
// （`…data: [DO` | `NE]\n\n`）。这种形态下行锚定永不命中 ⇒ 终止符照样抢先、收场照样补第二个 [DONE]。
// 修法：尾部是终止行前缀就先扣住（carry），下一块拼上后整体判；不是终止帧就立刻原样放行。
process.env.MSLXDFF_MAX_STREAM_MS = "80";
process.env.MSLXDFF_KEEPALIVE_MS = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
const { relay } = await import("../src/routes/stream.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeRes() {
  return {
    statusCode: 200, headers: {}, wrote: [], ended: false, _handlers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = String(v); },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    write(c) { this.wrote.push(Buffer.isBuffer(c) ? c.toString("utf8") : String(c)); return true; },
    end(c) { this.ended = true; if (c != null) this.wrote.push(String(c)); },
    on(k, fn) { (this._handlers[k] ??= []).push(fn); return this; },
    removeListener(k, fn) { const a = this._handlers[k]; if (a) this._handlers[k] = a.filter((f) => f !== fn); return this; },
    emit(k, ...a) { for (const f of [...(this._handlers[k] || [])]) f(...a); },
  };
}
const frame = (o) => `data: ${JSON.stringify(o)}\n\n`;
const up = (body) => ({ status: 200, headers: new Headers({ "content-type": "text/event-stream" }), body });

const doneLines = (out) => (out.match(/(?:^|\n)data: \[DONE\]\r?(?=\n|$)/g) || []).length;

// BUG-40：空轮 + `[DONE]` 被 TCP 切开时留口必须仍然生效。
// 原 `isTrivialFrame` 只看**本块**：`[DONE]` 的续块（`NE]\n\n`）自身不含 `data:` ⇒ 必判非空 ⇒
// 调用方走 submit 提交，wrotePayload 翻真、heldOpen 翻假 —— 空轮救援机制整体失效（实测：
// 整块 [DONE] 时 heldOpen=true，一旦被切块就变 false，且下游多收到一份本该被撤销的空轮字节）。
test("空轮 + [DONE] 被 TCP 切成两块：留口仍须生效，且一字节都不写下游", async () => {
  const res = fakeRes();
  const body = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(frame({ choices: [{ index: 0, delta: {}, finish_reason: null }] }), "utf8");
      yield Buffer.from("data: [DO", "utf8"); // [DONE] 被切开
      yield Buffer.from("NE]\n\n", "utf8");
      await sleep(50);
    },
    cancel() {},
  };
  const r = await relay(res, up(body), { stream: true });
  assert.equal(r.detail.wrotePayload, false, "空轮不得被判成已写出真实载荷");
  assert.equal(r.heldOpen, true, "留口必须仍然生效（切块不得摧毁空轮救援）");
  assert.equal(r.detail.exitReason, "empty-turn-hold");
  assert.equal(res.wrote.join(""), "", "空轮的所有帧都应被暂扣，客户端一字节都不该收到");
});

// 反面对照：有正文的空轮不是空轮，必须照常转发（防修复过度把真实输出也扣住）
test("有正文时 [DONE] 切块：正文照常转发，不得被误扣", async () => {
  const res = fakeRes();
  const body = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(frame({ choices: [{ index: 0, delta: { content: "真实回答" } }] }), "utf8");
      yield Buffer.from("data: [DO", "utf8");
      yield Buffer.from("NE]\n\n", "utf8");
      await sleep(50);
    },
    cancel() {},
  };
  const r = await relay(res, up(body), { stream: true });
  const out = res.wrote.join("");
  assert.ok(out.includes("真实回答"), "正文必须到达客户端");
  assert.equal(doneLines(out), 1, "终止符恰好一个");
  assert.equal(r.detail.wrotePayload, true);
});

test("终止帧被 TCP 切成两块：仍须扣住、错误帧在前、终止符恰好一个", async () => {
  const res = fakeRes();
  const body = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(frame({ choices: [{ index: 0, delta: { content: "半个回答" } }] }) + "data: [DO", "utf8");
      yield Buffer.from("NE]\n\n", "utf8");
      await sleep(200);
    },
    cancel() {},
  };
  const r = await relay(res, up(body), { stream: true });
  const out = res.wrote.join("");
  assert.equal(r.truncated, true);
  assert.equal(doneLines(out), 1, "终止符只能有一个");
  assert.ok(out.indexOf("STREAM_TRUNCATED") < out.indexOf("data: [DONE]"), "错误帧必须先于 [DONE]");
  assert.ok(out.includes("半个回答"), "正文不得损坏");
});

test("切成三块（`data: [D` | `ON` | `E]\\n\\n`）也要认出来", async () => {
  const res = fakeRes();
  const body = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(frame({ choices: [{ index: 0, delta: { content: "答" } }] }) + "data: [D", "utf8");
      yield Buffer.from("ON", "utf8");
      yield Buffer.from("E]\n\n", "utf8");
      await sleep(200);
    },
    cancel() {},
  };
  const r = await relay(res, up(body), { stream: true });
  const out = res.wrote.join("");
  assert.equal(r.truncated, true);
  assert.equal(doneLines(out), 1);
  assert.ok(out.indexOf("STREAM_TRUNCATED") < out.indexOf("data: [DONE]"));
});

test("尾部只是形似前缀的正文（不是终止行）：下一块到齐后原样放行，不吞字节", async () => {
  const res = fakeRes();
  const body = {
    async *[Symbol.asyncIterator]() {
      // 正文以 "data: [DO" 结尾（这是真的模型输出，不是终止帧），下一块继续正文
      yield Buffer.from(frame({ choices: [{ index: 0, delta: { content: "前缀很像" } }] }), "utf8");
      yield Buffer.from("data: [DO", "utf8");
      yield Buffer.from("UBLE-NOT-DONE] 后续正文\n\n", "utf8");
      await sleep(200);
    },
    cancel() {},
  };
  const r = await relay(res, up(body), { stream: true });
  const out = res.wrote.join("");
  assert.ok(out.includes("data: [DOUBLE-NOT-DONE]"), "被扣住的半截行必须原样补出去");
  assert.equal(doneLines(out), 1, "仍然只有一个真正的终止符（收场补的）");
});

// BUG-26：carry 原先只在 submit() 里被消化，hold() 的两个分支与注释帧直写都绕过它。
// 后果一：半截行与随后的 [DONE] 粘成 `data: [DOdata: [DONE]`（非法行，实测终止符数=0，比 BUG-25 的 2 个更糟）；
// 后果二：已提交后 trivial 空帧抢在半截行之前写出（乱序）。
test("半截行后面跟一个独立 [DONE]：必须先补换行，否则终止符粘成非法行", async () => {
  const res = fakeRes();
  const body = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(frame({ choices: [{ index: 0, delta: { content: "正文" } }] }) + "data: [DO", "utf8");
      yield Buffer.from(frame({ choices: [{ index: 0, delta: {} }] }), "utf8"); // trivial 空帧：走 hold 的 committed 分支
      yield Buffer.from("data: [DONE]\n\n", "utf8");
      await sleep(200);
    },
    cancel() {},
  };
  const r = await relay(res, up(body), { stream: true });
  const out = res.wrote.join("");
  assert.equal(doneLines(out), 1, "终止符必须能被客户端认出（粘行会变成 0 个）");
  assert.ok(out.includes("data: [DO\n"), "半截行必须以换行收尾再交给下游");
  assert.ok(!out.includes("data: [DOdata:"), "绝不能与后续帧粘成一行");
  assert.ok(out.indexOf("data: [DO") < out.indexOf('"delta":{}'), "半截行是先到的字节，必须排在空帧前面");
  assert.equal(r.truncated, true);
});

test("上游断在半截终止行上：收场也要把这段字节放出去，不能吞", async () => {
  const res = fakeRes();
  const body = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(frame({ choices: [{ index: 0, delta: { content: "答" } }] }) + "data: [DO", "utf8");
      await sleep(200); // 上游就此断掉，剩下的 NE] 永远不会来
    },
    cancel() {},
  };
  const r = await relay(res, up(body), { stream: true });
  const out = res.wrote.join("");
  assert.equal(r.truncated, true);
  assert.ok(out.includes("data: [DO"), "半截行来自上游，必须原样透传");
  assert.equal(doneLines(out), 1, "收场补的终止符仍只有一个");
});
