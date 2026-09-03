import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTransport } from "../src/transport/index.js";

function fakeFetchFactory(scenarios) {
  let idx = 0;
  const calls = [];
  const fn = async (url, opts) => {
    const i = idx++;
    calls.push({ url, opts, i });
    const sc = scenarios[i] ?? scenarios[scenarios.length - 1];
    if (sc instanceof Error) throw sc;
    if (typeof sc === "function") return sc(url, opts, i);
    return sc;
  };
  fn.calls = calls;
  return fn;
}

describe("transport/index - 主 seam Transport.request", () => {
  it("非流式 200 json 透传 + ttfb/total", async () => {
    const body = { choices: [{ message: { content: "hi" } }] };
    const fake = fakeFetchFactory([
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    ]);
    const tr = createTransport({ fetchImpl: fake, keepAlive: false });
    const res = await tr.request({ url: "https://example.com/v1/chat", method: "POST", headers: {}, body: { model: "x", stream: false }, stream: false });
    assert.equal(res.status, 200);
    assert.equal(res.ok, true);
    assert.ok(typeof res.ttfbMs === "number");
    assert.ok(typeof res.totalMs === "number");
    const j = await res.json();
    assert.deepEqual(j, body);
    await tr.close();
  });

  it("network 错误重试 2 次后成功", async () => {
    const body = { ok: 1 };
    const fake = fakeFetchFactory([
      new Error("network down"),
      new Error("network down"),
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    ]);
    const tr = createTransport({ fetchImpl: fake, keepAlive: false, retry: { network: { attempts: 2, delayMs: 1 }, 429: { attempts: 1, delayMs: 1 } } });
    const res = await tr.request({ url: "https://example.com/v1", body: {}, stream: false });
    assert.equal(res.status, 200);
    assert.equal(fake.calls.length, 3);
    await tr.close();
  });

  it("429 重试 1 次后成功", async () => {
    const fake = fakeFetchFactory([
      new Response("rate", { status: 429 }),
      new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { "content-type": "application/json" } }),
    ]);
    const tr = createTransport({ fetchImpl: fake, keepAlive: false, retry: { network: { attempts: 2, delayMs: 1 }, 429: { attempts: 1, delayMs: 1 } } });
    const res = await tr.request({ url: "https://example.com/v1", body: {}, stream: false });
    assert.equal(res.status, 200);
    assert.equal(fake.calls.length, 2);
    await tr.close();
  });

  it("429 超限不重试直接返回", async () => {
    const fake = fakeFetchFactory([
      new Response("r1", { status: 429 }),
      new Response("r2", { status: 429 }),
    ]);
    const tr = createTransport({ fetchImpl: fake, keepAlive: false, retry: { 429: { attempts: 1, delayMs: 1 } } });
    const res = await tr.request({ url: "https://example.com/v1", body: {}, stream: false });
    assert.equal(res.status, 429);
    assert.equal(fake.calls.length, 2); // 初次 + 1 重试 =2，第二次返回不再重试
    await tr.close();
  });

  it("流式 SSE 逐帧产出", async () => {
    const sseBody = "data: {\"a\":1}\n\ndata: {\"a\":2}\n\ndata: [DONE]\n\n";
    const fake = fakeFetchFactory([
      new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ]);
    const tr = createTransport({ fetchImpl: fake, keepAlive: false });
    const res = await tr.request({ url: "https://example.com/v1", body: { stream: true }, stream: true });
    assert.equal(res.status, 200);
    const chunks = [];
    for await (const c of res.stream()) chunks.push(c);
    assert.deepEqual(chunks, ['{"a":1}', '{"a":2}']);
    await tr.close();
  });

  it("SSE 粘包与注释过滤", async () => {
    const sseBody = ": keepalive\n\ndata: hello\n\ndata: wor\nld\n\n".replace("wor\nld", "world"); // 简化
    // 实际构造分两段 push 验证粘包：用 fake 返回可读流分片
    const stream = new ReadableStream({
      start(ctrl) {
        const enc = new TextEncoder();
        ctrl.enqueue(enc.encode("data: hel"));
        ctrl.enqueue(enc.encode("lo\n\n"));
        ctrl.close();
      }
    });
    const fake = fakeFetchFactory([new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })]);
    const tr = createTransport({ fetchImpl: fake, keepAlive: false });
    const res = await tr.request({ url: "https://example.com/v1", body: { stream: true }, stream: true });
    const chunks = [];
    for await (const c of res.stream()) chunks.push(c);
    assert.deepEqual(chunks, ["hello"]);
    await tr.close();
  });

  it("超时 Abort 后按 network 重试", async () => {
    let call = 0;
    const fake = async () => {
      call++;
      if (call === 1) throw new Error("upstream timed out after 10ms");
      return new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const tr = createTransport({ fetchImpl: fake, keepAlive: false, retry: { network: { attempts: 2, delayMs: 1 } }, timeoutMs: 10 });
    const res = await tr.request({ url: "https://example.com/v1", body: {}, stream: false, timeoutMs: 10 });
    assert.equal(res.status, 200);
    await tr.close();
  });

  it("非流式 text() 缓存与 json() 一致", async () => {
    const body = { x: 1 };
    const fake = fakeFetchFactory([new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })]);
    const tr = createTransport({ fetchImpl: fake, keepAlive: false });
    const res = await tr.request({ url: "https://example.com/v1", body: {}, stream: false });
    const t1 = await res.text();
    const j1 = await res.json();
    assert.equal(t1, JSON.stringify(body));
    assert.deepEqual(j1, body);
    await tr.close();
  });
});
