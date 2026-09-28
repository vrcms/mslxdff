// qoder 额度错（Billing daily count exceeded）→ 直接换号；全号额度耗尽 → 明确错误提示。
// 事故背景：额度错裹在 HTTP 200 SSE 信封内层 code=110，旧逻辑判 business（无 status）→
// 不冷却不换号 → 客户端收泛化 EMPTY_MODEL_RESPONSE，死号被反复 hammer。
// 设计要点：换号在 provider 内部完成（不依赖外层空转重试链路，那条链路在非流式路径上不触发）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createQoderProvider } from "../src/providers/qoder/index.js";
import { extractDelta, errorStatus } from "../src/providers/qoder/sse.js";

const blob = (t) => JSON.stringify({ device_token: t, refresh_token: "" });
const body = { model: "qoder/qfmodel", messages: [{ role: "user", content: "hi" }], stream: true };

// 造 qoder 信封帧：body 是「内层 JSON 的字符串」
const env = (inner) =>
  `data:${JSON.stringify({ headers: { "Content-Type": ["application/json"] }, body: JSON.stringify(inner), statusCodeValue: 200, statusCode: "OK" })}\n\n`;
const inner = (frame) => frame.trim().slice(5);

const quotaFrame = () => env({ code: "110", message: "Billing daily count exceeded" });
const contentFrame = (t) => env({ choices: [{ index: 0, delta: { content: t } }] });
const DONE = "data:[DONE]\n\n";

// 按调用次序返回不同响应体（同一次请求内的换号重发会依次命中）
function seqUpstream(...texts) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const t = texts[Math.min(calls.length - 1, texts.length - 1)];
    return new Response(t, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  fn.calls = calls;
  return fn;
}

function mk(fetchImpl) {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-qoder-quota-"));
  // cooldownMs=1 与 quotaCooldownMs=60s 拉开量级：能证明额度走的是长冷却而非普通短冷却
  const p = createQoderProvider({
    id: "qoder",
    apiKeys: [blob("dt-a"), blob("dt-b")],
    file: join(dir, "state.json"),
    fetchImpl,
    cooldownMs: 1,
    quotaCooldownMs: 60_000,
  });
  return { p, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const cooling = (p) => p.keyRing.keys.filter((k) => p.keyRing.isCooling(k)).length;

test("sse：内层 code 110 → quota 错，状态码 429", () => {
  const d = extractDelta(inner(quotaFrame()));
  assert.equal(d.err.kind, "quota");
  assert.equal(errorStatus(d.err), 429);
});

test("sse：普通业务码仍归 business（不误伤）", () => {
  const d = extractDelta(inner(env({ code: "115", message: "quota exceeded" })));
  assert.equal(d.err.kind, "business");
});

test("sse：外层 403 信封 + 内层 110 → 仍判 quota（实测真实形态）", () => {
  // 实测原样：外层 statusCodeValue:403（FORBIDDEN），body 字符串里裹内层 code 110
  const frame = `data:${JSON.stringify({ headers: {}, body: JSON.stringify({ code: "110", message: "Billing daily count exceeded" }), statusCodeValue: 403, statusCode: "FORBIDDEN" })}`;
  const d = extractDelta(frame.slice(5));
  assert.equal(d.err.kind, "quota", "不能因外层 403 就把额度错当普通鉴权错");
  assert.equal(errorStatus(d.err), 429);
});

test("额度错：换到下一个号，并把该号长冷却", async () => {
  const up = seqUpstream(quotaFrame() + DONE, contentFrame("ok") + DONE);
  const { p, cleanup } = mk(up);
  try {
    const r = await p.chat(body, { reqId: "q1" });
    const text = await r.text();
    assert.equal(r.status, 200, "换号后正常返回");
    assert.match(text, /ok/, "内容来自第二个号");
    assert.equal(up.calls.length, 2, "第一发额度错 → 必须换号重发");
    assert.equal(cooling(p), 1, "额度号被冷却");
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(cooling(p), 1, "额度号是长冷却（20ms 后仍在冷却，普通冷却只有 1ms）");
  } finally { cleanup(); }
});

test("全部号额度耗尽 → 429 明确提示，且此后不再打上游", async () => {
  const up = seqUpstream(quotaFrame() + DONE);
  const { p, cleanup } = mk(up);
  try {
    const r = await p.chat(body, { reqId: "q2" });
    assert.equal(r.status, 429, "全号额度耗尽必须直接报错，不再回 200 空流");
    const j = JSON.parse(await r.text());
    assert.match(j.error.message, /额度已用完/);
    assert.equal(r.headers.get("x-mslxdff-qoder-quota-exhausted"), "1");
    const n = up.calls.length;
    const r2 = await p.chat(body, { reqId: "q3" });
    assert.equal(r2.status, 429, "全号额度冷却中，下次请求直接提示");
    assert.equal(up.calls.length, n, "无可用号时不再打上游");
  } finally { cleanup(); }
});

// ---- 判定收紧（只认上游明确额度信号）----

const queueFrame = () => {
  // 实测原样：403 信封 → code 10605 → isQueued:true, serviceAvailable:true（排队，绝非额度）
  const innerMsg = JSON.stringify({ isQueued: true, modelKey: "qfmodel", retryAfterSeconds: 30, serviceAvailable: true });
  const layer2 = JSON.stringify({ code: "10605", message: innerMsg });
  return `data:${JSON.stringify({ headers: {}, body: layer2, statusCodeValue: 403, statusCode: "FORBIDDEN" })}\n\n`;
};

test("sse：排队 10605 → 不判 quota（不得误报没额度）", () => {
  const d = extractDelta(queueFrame().trim().slice(5));
  assert.notEqual(d.err?.kind, "quota", "排队错不是额度错");
  assert.equal(d.err?.status, 403);
});

test("sse：三层嵌套里内层 110 → 仍显式命中 quota", () => {
  const innerMsg = JSON.stringify({ code: "110", message: "Billing daily count exceeded" });
  const layer2 = JSON.stringify({ code: "10605", message: innerMsg });
  const frame = `data:${JSON.stringify({ headers: {}, body: layer2, statusCodeValue: 403, statusCode: "FORBIDDEN" })}`;
  const d = extractDelta(frame.slice(5));
  assert.equal(d.err.kind, "quota", "深一层嵌套也要命中");
});

test("仅一个号额度错、其余可用 → 换号拿到正常响应，不报全灭", async () => {
  // 三号：第一发额度错，之后返回内容（模拟有额度的号在后续轮转中命中）
  const up = seqUpstream(quotaFrame() + DONE, contentFrame("healthy") + DONE);
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-qoder-quota-"));
  const p = createQoderProvider({
    id: "qoder",
    apiKeys: [blob("dt-a"), blob("dt-b"), blob("dt-c")],
    file: join(dir, "state.json"),
    fetchImpl: up,
    cooldownMs: 1,
    quotaCooldownMs: 60_000,
  });
  try {
    const r = await p.chat(body, { reqId: "partial" });
    assert.equal(r.status, 200, "还有有额度的号时必须给出响应");
    assert.equal(r.headers.get("x-mslxdff-qoder-quota-exhausted"), null, "不得声称全号额度耗尽");
    assert.match(await r.text(), /healthy/, "内容来自有额度的号");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("一号额度错 + 其余因非额度原因冷却 → 不报 quota_exhausted", async () => {
  // 两次额度错 + 第三发上游 500（非额度）→ 收口应是上游真错，不是"所有号没额度"
  const up = seqUpstream(quotaFrame() + DONE, quotaFrame() + DONE, "data:" + JSON.stringify({ statusCodeValue: 500, body: "boom" }) + "\n\n" + DONE);
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-qoder-quota-"));
  const p = createQoderProvider({
    id: "qoder",
    apiKeys: [blob("dt-a"), blob("dt-b"), blob("dt-c")],
    file: join(dir, "state.json"),
    fetchImpl: up,
    cooldownMs: 1,
    quotaCooldownMs: 60_000,
  });
  try {
    const r = await p.chat(body, { reqId: "mixed" });
    assert.notEqual(r.headers.get("x-mslxdff-qoder-quota-exhausted"), "1", "不是全号额度耗尽就不得报全灭");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 真机复现的最小化：额度号 + 两个"非额度冷却"号。
// 旧逻辑在第 3 发（全部号都在冷却、只有一个号是额度标记）时会误报"所有账号额度已用完"。
test("仅一个号是额度错、其余是非额度冷却 → 不得报全灭", async () => {
  const nonQuota = () => {
    const innerMsg = JSON.stringify({ isQueued: true, serviceAvailable: true, retryAfterSeconds: 30 });
    const layer2 = JSON.stringify({ code: "10605", message: innerMsg });
    return `data:${JSON.stringify({ headers: {}, body: layer2, statusCodeValue: 403, statusCode: "FORBIDDEN" })}\n\n`;
  };
  // 只有第一发是额度错；后续都是 10605 排队（非额度）
  const up = seqUpstream(quotaFrame() + DONE, nonQuota() + DONE, nonQuota() + DONE);
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-qoder-quota-"));
  const p = createQoderProvider({
    id: "qoder",
    apiKeys: [blob("dt-a"), blob("dt-b"), blob("dt-c")],
    file: join(dir, "state.json"),
    fetchImpl: up,
    cooldownMs: 60_000,   // 非额度冷却保持住，不靠 1ms 快速恢复抢时序
    quotaCooldownMs: 120_000,
  });
  try {
    // 三发用不同 reqId：各自独立选号，累积冷却直到全号冷却
    await (await p.chat(body, { reqId: "r1" })).text();
    await (await p.chat(body, { reqId: "r2" })).text();
    const r3 = await p.chat(body, { reqId: "r3" });
    const txt = await r3.text().catch(() => "");
    assert.notEqual(
      r3.headers.get("x-mslxdff-qoder-quota-exhausted"), "1",
      "只有一个号是额度错，其余只是排队冷却 → 不得声称所有账号额度已用完",
    );
    assert.doesNotMatch(txt, /所有账号额度已用完/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
