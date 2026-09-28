// qoder-envelope-status.test.js — 流内错误（HTTP 200 + SSE 信封内非 200）也要把真实状态码带到门面
// 事故背景：qoder 上游把限流裹在 200 的信封里（statusCodeValue:403 / serviceAvailable:false），
// chat.js 的流式路径没挂 x-mslxdff-qoder-upstream-status → 门面 ust 恒 0 → 坏号不冷却、
// 粘号不换号 → 94 次 502 空转、0 次恢复。对外契约不变：流式仍恒 200。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createQoderProvider } from "../src/providers/qoder/index.js";

const blob = (t) => JSON.stringify({ device_token: t, refresh_token: "" });
const body = { model: "qoder/qfmodel", messages: [{ role: "user", content: "hi" }], stream: true };

// 造 qoder 的信封帧：body 是「内层 JSON 的字符串」
const env = (inner, statusCodeValue = 200, statusCode = "OK") =>
  `data:${JSON.stringify({
    headers: { "Content-Type": ["application/json"] },
    body: JSON.stringify(inner),
    statusCodeValue,
    statusCode,
  })}\n\n`;

// 上游限流判决（实测原样）：403 + serviceAvailable:false + 30s 退避
const queueFrame = (code = "403", sc = "FORBIDDEN", scv = 403) =>
  env({ code: String(scv), message: JSON.stringify({ code: "10605", message: { isQueued: true, modelKey: "qfmodel", retryAfterSeconds: 30, serviceAvailable: false } }) }, scv, sc);

const contentFrame = (text) => env({ choices: [{ index: 0, delta: { content: text } }] });
const DONE = "data:[DONE]\n\n";

function mkUpstream(sseText, init = {}) {
  return async () => new Response(sseText, { status: 200, headers: { "Content-Type": "text/event-stream" }, ...init });
}

function mk(fetchImpl) {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-qoder-env-"));
  const p = createQoderProvider({
    id: "qoder",
    apiKeys: [blob("dt-a"), blob("dt-b")],
    file: join(dir, "state.json"), // 隔离 state：不读开发者真实账号
    fetchImpl,
  });
  return { p, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const coolingCount = (p) => p.keyRing.keys.filter((k) => p.keyRing.isCooling(k)).length;

test("流内 403 判决：状态码带出门面 + 该号冷却 + 同请求重试换号", async () => {
  const { p, cleanup } = mk(mkUpstream(queueFrame() + DONE));
  try {
    const r1 = await p.chat(body, { reqId: "e1" });
    const text1 = await r1.text().catch(() => "");
    assert.equal(r1.status, 200, "流式对外仍恒 200（契约不变）");
    assert.equal(r1.headers.get("x-mslxdff-qoder-upstream-status"), "403", "信封内 403 必须带出门面");
    assert.equal(r1.headers.get("x-mslxdff-qoder-cooldown"), "403", "坏号冷却决定要钉在响应上");
    assert.equal(coolingCount(p), 1, "恰好一个号被冷却");
    assert.match(text1, /event: error/, "仍以流内 error 事件告知客户端");
    assert.equal(r1.headers.get("x-mslxdff-qoder-account"), "new", "首次选号 decision=new");

    const r2 = await p.chat(body, { reqId: "e1" });
    await r2.text().catch(() => "");
    assert.equal(r2.headers.get("x-mslxdff-qoder-account"), "switch", "坏号冷却后同请求重试必须换号");
  } finally { cleanup(); }
});

test("流内 429 判决：同样冷却并换号", async () => {
  const { p, cleanup } = mk(mkUpstream(env({ code: "429", message: "rate limited" }, 429, "RESOURCE_EXHAUSTED") + DONE));
  try {
    const r1 = await p.chat(body, { reqId: "e2" });
    await r1.text().catch(() => "");
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get("x-mslxdff-qoder-upstream-status"), "429");
    assert.equal(r1.headers.get("x-mslxdff-qoder-cooldown"), "429");
    assert.equal(coolingCount(p), 1);
    const r2 = await p.chat(body, { reqId: "e2" });
    await r2.text().catch(() => "");
    assert.equal(r2.headers.get("x-mslxdff-qoder-account"), "switch");
  } finally { cleanup(); }
});

test("流内 400 业务错：状态码带出但不冷却（不误伤好号）", async () => {
  const { p, cleanup } = mk(mkUpstream(env({ code: "400", message: "bad request" }, 400, "INVALID_ARGUMENT") + DONE));
  try {
    const r = await p.chat(body, { reqId: "e3" });
    await r.text().catch(() => {});
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-mslxdff-qoder-upstream-status"), "400");
    assert.equal(r.headers.get("x-mslxdff-qoder-cooldown"), null, "400 是业务错，不冷却");
    assert.equal(coolingCount(p), 0);
  } finally { cleanup(); }
});

test("流内正常内容：预读不丢内容、不加冷却头", async () => {
  const { p, cleanup } = mk(mkUpstream(contentFrame("hello ") + contentFrame("world") + DONE));
  try {
    const r = await p.chat(body, { reqId: "e4" });
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.ok(text.includes("hello "), "预读的首帧内容必须回灌，不能丢");
    assert.ok(text.includes("world"), "后续帧内容必须完整");
    assert.equal(r.headers.get("x-mslxdff-qoder-upstream-status"), null, "正常流不挂状态码头");
    assert.equal(r.headers.get("x-mslxdff-qoder-cooldown"), null, "正常流不冷却");
    assert.equal(coolingCount(p), 0);
    assert.equal(r.headers.get("x-mslxdff-qoder-account"), "new");
  } finally { cleanup(); }
});

test("端到端：Qoder 流内 10605 信封经 relay 成功提取 retryAfterSeconds 文案", async () => {
  const { p, cleanup } = mk(mkUpstream(queueFrame() + DONE));
  try {
    const { relay } = await import("../src/routes/stream.js");
    const fakeRes = {
      statusCode: 200,
      headers: {},
      wrote: [],
      setHeader(k, v) { this.headers[k.toLowerCase()] = String(v); },
      getHeader(k) { return this.headers[k.toLowerCase()]; },
      write(c) { this.wrote.push(Buffer.isBuffer(c) ? c.toString("utf8") : String(c)); return true; },
      end() {},
      on() { return this; },
      removeListener() { return this; },
    };
    const upRes = await p.chat(body, { reqId: "e5" });
    const out = await relay(fakeRes, upRes, { stream: true }, { streamTimeoutMs: 5000 });
    assert.match(String(out.detail.upstreamErrorText), /上游供应商触发 retryAfterSeconds: 30 ，请等候重试/);
    assert.equal(out.detail.heldErrorChunks, 1);
  } finally { cleanup(); }
});
