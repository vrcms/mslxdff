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
  const fn = async () => { fn.calls.push(1); return new Response(sseText, { status: 200, headers: { "Content-Type": "text/event-stream" }, ...init }); };
  fn.calls = [];
  return fn;
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

// 2026-10-05 起：排队判决（10605/isQueued）与额度同为「同请求内换号」信号，并单独一档长冷却。
// 本用例的上游对每个号都回排队 → 一次请求把两号轮完、双双长冷却。
// 旧行为（本测试的前身）：一发只冷却一个号、把排队判决原样递给客户端，外层 2s 后粘号又送回同一个号。
test("流内 403 排队判决：状态码+排队旗标带出门面、同请求轮完全部号、全冷却后被迫那一发要留痕", async () => {
  const up = mkUpstream(queueFrame() + DONE);
  const { p, cleanup } = mk(up);
  try {
    const r1 = await p.chat(body, { reqId: "e1" });
    const text1 = await r1.text().catch(() => "");
    assert.equal(r1.status, 200, "流式对外仍恒 200（契约不变）");
    assert.equal(r1.headers.get("x-mslxdff-qoder-upstream-status"), "403", "信封内 403 必须带出门面");
    assert.equal(r1.headers.get("x-mslxdff-qoder-cooldown"), "403", "坏号冷却决定要钉在响应上");
    assert.equal(r1.headers.get("x-mslxdff-qoder-queued"), "1", "排队旗标必须带出（冷却分档靠它）");
    assert.equal(up.calls.length, 2, "排队号必须当场换号，而不是把判决递给客户端");
    assert.equal(coolingCount(p), 2, "两号都排队 → 全部冷却");
    assert.match(text1, /event: error/, "仍以流内 error 事件告知客户端");
    assert.equal(r1.headers.get("x-mslxdff-qoder-account"), "switch", "第二次尝试是同请求内换上去的号");
    // 既有契约：冷却是「轮转偏好」不是硬拒——全号都在冷却时仍会 forced 补一发（标账可查）。
    const n = up.calls.length;
    const r2 = await p.chat(body, { reqId: "e1" });
    const t2 = await r2.text().catch(() => "");
    assert.equal(r2.headers.get("x-mslxdff-qoder-account"), "forced", "全号冷却 → 必须是 forced 而非 new/switch");
    assert.equal(up.calls.length, n + 1, "forced 那一发仍打上游（本次不改这条既有契约）");
    assert.notEqual(r2.headers.get("x-mslxdff-qoder-quota-exhausted"), "1", "排队不得谎称额度耗尽");
    assert.match(t2, /event: error/, "仍以流内 error 告知客户端");
    assert.equal(r2.headers.get("x-mslxdff-qoder-queued"), "1", "排队旗标继续带出，供上层观测");
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
