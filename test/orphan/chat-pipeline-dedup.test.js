import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createChatPipeline } from "../src/chat-pipeline/index.js";
import { createDedup } from "../src/chat-pipeline/dedup.js";

function fakeRes() {
  const h = {};
  let status = 0, body = null, ended = false;
  return {
    setHeader(k, v) { h[k.toLowerCase()] = String(v); },
    get headers() { return h; },
    statusCode: 0,
    headersSent: false,
    end() { ended = true; },
    _capture: { get status() { return status; }, set status(v) { status = v; }, get body() { return body; }, set body(v) { body = v; }, h, get ended() { return ended; } },
  };
}

function jsonResCapture(res, code, obj) {
  res.statusCode = code;
  res.headersSent = true;
  res._capture.status = code;
  res._capture.body = obj;
}

describe("chat-pipeline dedup", () => {
  it("同 ip+模型+消息 2s 内重复请求 429  dedup-hit", async () => {
    const events = [];
    const logs = { appendEvent(e) { events.push(e); }, appendCall() {}, appendError() {} };
    const bus = { emit(e) { events.push(e); } };
    let clock = 1000;
    const dedup = createDedup({ windowMs: 2000, now: () => clock });
    const pipeline = createChatPipeline({
      upstream: { chat: async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }) },
      logs, bus, peers: { ordered: () => [] }, groups: null, token: "t", dedup,
    });

    const body = { model: "workbuddy/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], stream: true };
    const req1 = { headers: {}, body, socket: { remoteAddress: "127.0.0.1" } };
    const res1 = fakeRes();
    // 注入 json 捕获：pipeline 内部调 json(res,429)
    const origJson = (await import("../src/routes/helpers.js")).json;
    // 直接跑两次，第二次应在窗口内
    // 第一次：先手动模拟让 dedup 通过，然后 engine 会尝试走 upstream（我们让它快速结束）
    // 为简化，直接测 dedup 实例本身 + pipeline 的 429 路径：
    const r1 = dedup.check({ ip: "127.0.0.1", requested: "workbuddy/deepseek-v4.1-flash", body });
    assert.equal(r1.dup, false);
    clock += 500;
    const r2 = dedup.check({ ip: "127.0.0.1", requested: "workbuddy/deepseek-v4.1-flash", body });
    assert.equal(r2.dup, true);
    assert.ok(r2.ageMs < 2000);

    // pipeline 层面：第二次请求应直接 429
    clock = 5000;
    const dedup2 = createDedup({ windowMs: 2000, now: () => clock });
    const pipeline2 = createChatPipeline({
      upstream: { chat: async () => new Response("ok", { status: 200 }) },
      logs, bus, peers: { ordered: () => [] }, groups: null, token: "t", dedup: dedup2,
    });
    // 先占一次
    dedup2.check({ ip: "127.0.0.1", requested: "workbuddy/deepseek-v4.1-flash", body });
    const req = { headers: {}, body, socket: { remoteAddress: "127.0.0.1" } };
    const res = {
      statusCode: 0, headersSent: false, _h: {},
      setHeader(k, v) { this._h[k.toLowerCase()] = String(v); },
      end() {},
    };
    let jsonCalled = null;
    // monkey patch json in pipeline's scope：通过直接调用 pipeline，捕获 res 状态
    await pipeline2.execute({ req, res });
    assert.equal(res.statusCode, 429);
    assert.ok(events.some((e) => e.type === "dedup-hit"));
  });

  it("不同消息不算重复", () => {
    const dedup = createDedup({ windowMs: 2000, now: () => 1000 });
    const b1 = { model: "workbuddy/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], stream: true };
    const b2 = { model: "workbuddy/deepseek-v4.1-flash", messages: [{ role: "user", content: "hello" }], stream: true };
    assert.equal(dedup.check({ ip: "127.0.0.1", requested: "workbuddy/deepseek-v4.1-flash", body: b1 }).dup, false);
    assert.equal(dedup.check({ ip: "127.0.0.1", requested: "workbuddy/deepseek-v4.1-flash", body: b2 }).dup, false);
  });

  it("窗口外不算重复", () => {
    let t = 0;
    const dedup = createDedup({ windowMs: 2000, now: () => t });
    const b = { model: "workbuddy/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], stream: true };
    t = 0; assert.equal(dedup.check({ ip: "1.1.1.1", requested: "workbuddy/deepseek-v4.1-flash", body: b }).dup, false);
    t = 2500; assert.equal(dedup.check({ ip: "1.1.1.1", requested: "workbuddy/deepseek-v4.1-flash", body: b }).dup, false);
  });

  it("MSLXDFF_DEDUP_WINDOW_MS=0 关闭去重", () => {
    const prev = process.env.MSLXDFF_DEDUP_WINDOW_MS;
    process.env.MSLXDFF_DEDUP_WINDOW_MS = "0";
    const d = createDedup({ windowMs: 0, now: () => 0 });
    const b = { model: "a", messages: [{ role: "user", content: "hi" }] };
    assert.equal(d.check({ ip: "1.1.1.1", requested: "a", body: b }).dup, false);
    assert.equal(d.check({ ip: "1.1.1.1", requested: "a", body: b }).dup, false);
    if (prev == null) delete process.env.MSLXDFF_DEDUP_WINDOW_MS; else process.env.MSLXDFF_DEDUP_WINDOW_MS = prev;
  });
});
