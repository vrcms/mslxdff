// qoder-queue-switch.test.js — 排队判决（10605/isQueued）：同请求内换号 + 独立冷却档
// 现网依据：31h 窗口内 global 区 176 发被判决 129 发（跨小时不复现恢复），cn 区 98 发 0 判决。
// 旧行为把排队当普通 403：只冷却 30s、同一请求内不换号 → 客户端白收一发排队判决，
// 外层空转重试 2s 后又用粘号送回同一个还在排队的号。
// 契约红线（本文件锁死）：流式对外仍恒 200 + 流内 error；err.kind 仍是 "upstream"（errorStatus 与
// 流内 error 的 type 字段一律不变），排队只以 x-mslxdff-qoder-queued 内部旗标交接。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createQoderProvider } from "../src/providers/qoder/index.js";
import { extractDelta, errorStatus, findQueueSignal } from "../src/providers/qoder/sse.js";
import { upstreamEcho, formatModelTrace } from "../src/model-trace.js";

const blob = (t) => JSON.stringify({ device_token: t, refresh_token: "" });
const body = { model: "qoder/qfmodel", messages: [{ role: "user", content: "hi" }], stream: true };

const env = (inner, statusCodeValue = 200, statusCode = "OK") =>
  `data:${JSON.stringify({ headers: { "Content-Type": ["application/json"] }, body: JSON.stringify(inner), statusCodeValue, statusCode })}\n\n`;
const DONE = "data:[DONE]\n\n";

// 实测形态：外层 403 → code 10605 → 内层 isQueued:true + retryAfterSeconds:30（serviceAvailable 为 true）
const queueFrame = () => env({
  code: "403",
  message: JSON.stringify({ code: "10605", message: JSON.stringify({ isQueued: true, modelKey: "qfmodel", retryAfterSeconds: 30, serviceAvailable: true }) }),
}, 403, "FORBIDDEN");
const contentFrame = (t) => env({ choices: [{ index: 0, delta: { content: t } }] });

function seqUpstream(...texts) {
  const calls = [];
  const fn = async () => {
    calls.push(1);
    return new Response(texts[Math.min(calls.length - 1, texts.length - 1)], { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  fn.calls = calls;
  return fn;
}

function mk(fetchImpl) {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-qoder-queue-"));
  // cooldownMs=1 与 queueCooldownMs=60s 拉开量级：能证明排队走的是队列档而非普通短冷却
  const p = createQoderProvider({
    id: "qoder",
    apiKeys: [blob("dt-a"), blob("dt-b")],
    file: join(dir, "state.json"), // 隔离 state：不读开发者真实账号
    fetchImpl,
    cooldownMs: 1,
    queueCooldownMs: 60_000,
    quotaCooldownMs: 120_000,
  });
  return { p, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const coolingCount = (p) => p.keyRing.keys.filter((k) => p.keyRing.isCooling(k)).length;

// ---- 判决解析 ----

test("sse：403+10605 信封 → 挂 queued 旗标，kind 仍是 upstream（状态码语义不得漂移）", () => {
  const d = extractDelta(queueFrame().trim().slice(5));
  assert.equal(d.err.queued, true);
  assert.equal(d.err.kind, "upstream", "不新增 kind：流内 error 的 type 与 errorStatus 都不变");
  assert.equal(errorStatus(d.err), 403);
});

test("sse：排队容器里裹 code 110 → 额度优先，且不得同时挂 queued", () => {
  const frame = env({
    code: "403",
    message: JSON.stringify({ code: "10605", message: JSON.stringify({ code: "110", message: "Billing daily count exceeded" }) }),
  }, 403, "FORBIDDEN").trim().slice(5);
  const d = extractDelta(frame);
  assert.equal(d.err.kind, "quota", "判序必须先额度、后排队");
  assert.equal(d.err.queued, undefined);
});

test("sse：普通 403（无排队信号）→ 不挂 queued（不误伤好号）", () => {
  const d = extractDelta(env({ code: "403", message: "forbidden" }, 403, "FORBIDDEN").trim().slice(5));
  assert.equal(d.err.queued, undefined);
  assert.equal(findQueueSignal({ code: "403", message: "forbidden" }), null);
});

// ---- 门面策略 ----

test("只有一号排队、另一号健康 → 同一请求内换号，客户端拿到正文", async () => {
  const up = seqUpstream(queueFrame() + DONE, contentFrame("healthy") + DONE);
  const { p, cleanup } = mk(up);
  try {
    const r = await p.chat(body, { reqId: "s1" });
    const text = await r.text();
    assert.equal(r.status, 200, "对外契约不变");
    assert.equal(up.calls.length, 2, "排队号必须当场换号");
    assert.match(text, /healthy/, "正文来自健康号，排队判决不递给客户端");
    assert.equal(r.headers.get("x-mslxdff-qoder-account"), "switch", "换号决定要留痕");
    assert.equal(r.headers.get("x-mslxdff-qoder-upstream-status"), null, "成功那一发不带判决头");
    assert.equal(r.headers.get("x-mslxdff-qoder-queued"), null, "成功那一发不挂排队旗标");
  } finally { cleanup(); }
});

test("排队号走队列档冷却（不是普通 30s 档）", async () => {
  const up = seqUpstream(queueFrame() + DONE, contentFrame("ok") + DONE);
  const { p, cleanup } = mk(up);
  try {
    await (await p.chat(body, { reqId: "s2" })).text();
    assert.equal(coolingCount(p), 1, "只有排队那个号被冷却");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(coolingCount(p), 1, "20ms 后仍在冷却 → 用的是 queueCooldownMs，不是 cooldownMs=1ms");
  } finally { cleanup(); }
});

test("排队号在队列冷却期内不被下一个新请求选中", async () => {
  const up = seqUpstream(queueFrame() + DONE, contentFrame("first") + DONE, contentFrame("second") + DONE);
  const { p, cleanup } = mk(up);
  try {
    await (await p.chat(body, { reqId: "r1" })).text(); // dt-a 排队 → 当场换 dt-b（first）
    const before = up.calls.length;
    const r = await p.chat(body, { reqId: "r2" });      // dt-a 仍在冷却 → 只能选 dt-b
    assert.match(await r.text(), /second/);
    assert.equal(r.headers.get("x-mslxdff-qoder-account"), "new", "新请求重新选号");
    assert.equal(up.calls.length, before + 1, "只打一发：没有再回到排队号白烧");
  } finally { cleanup(); }
});

test("非流式（stream:false）同样带出排队旗标并当场换号", async () => {
  const up = seqUpstream(queueFrame() + DONE, contentFrame("ns-ok") + DONE);
  const { p, cleanup } = mk(up);
  try {
    const r = await p.chat({ ...body, stream: false }, { reqId: "s3" });
    const text = await r.text();
    assert.equal(up.calls.length, 2, "非流式路径不吃外层空转重试，换号必须在 provider 内完成");
    assert.match(text, /ns-ok/);
  } finally { cleanup(); }
});

test("可观测：queued 经 upstreamEcho 落到 upstream-error 轨迹行", async () => {
  const up = seqUpstream(queueFrame() + DONE, queueFrame() + DONE);
  const { p, cleanup } = mk(up);
  try {
    const r = await p.chat(body, { reqId: "s4" });
    await r.text().catch(() => "");
    const echo = upstreamEcho(r);
    assert.equal(echo.queued, "1", "回显头要能被 pipeline 取到");
    const line = formatModelTrace({ type: "upstream-error", reqId: "s4", model: "qoder/qfmodel", data: { status: 502, message: "empty turn", ...echo } });
    assert.match(line, /queued=1/, "轨迹行必须能回答「这发为什么切号」");
  } finally { cleanup(); }
});
