// qoder-no-capacity.test.js — 排队「无容量」子型：10605 + queueCount:0 + serviceAvailable:false
// 现网依据（2026-10-22 真机 curl）：6 个 p3 免费号 deviceToken 刷新后鉴权通过，但 chat 全部命中
//   {"code":"10605", isQueued:true, modelKey:qfmodel, queueCount:0, queueType:p3, serviceAvailable:false, subCode:RESOURCE_LIMIT, retryAfterSeconds:30}
// 旧行为：403 → 当死号冷却换号 → 整池（同 p3 队列同容量）轮一遍各撞一墙，5.4s 白烧后客户端收 403。
// 新契约：识别 noCapacity → 不换号轮询，带 Retry-After 的 429 如实透给客户端按秒重试（对齐 magpie 503+Retry-After 语义）。
// 对照：真排队（queueCount>0 有人在等位）仍走换号（另一号可能有空位）——见 qoder-queue-switch.test.js。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createQoderProvider } from "../src/providers/qoder/index.js";
import { extractDelta, findQueueSignal, retryAfterFrom, findLoginSignal, isLoginExpired } from "../src/providers/qoder/sse.js";

const blob = (t) => JSON.stringify({ device_token: t, refresh_token: "" });
const reqBody = { model: "qoder/qfmodel", messages: [{ role: "user", content: "你好" }], stream: false };

// 真机原样（非 200 直出的 HTTP 403 body）：外层 {"error":{"message":"<JSON string>"}} 里裹 10605 无容量
const inner10605NoCap = (extra = {}) => JSON.stringify({
  code: "10605",
  message: JSON.stringify({ isQueued: true, modelKey: "qfmodel", queueCount: 0, queueType: "p3", retryAfterSeconds: 30, serviceAvailable: false, subCode: "RESOURCE_LIMIT", waitTime: 30, ...extra }),
});
const wrapped403Body = () => JSON.stringify({ code: "403", message: inner10605NoCap() });

// ---- sse.js 解析 ----
test("findQueueSignal：queueCount:0 + serviceAvailable:false → noCapacity=true", () => {
  const q = findQueueSignal(JSON.parse(inner10605NoCap()));
  assert.equal(q.code, "10605");
  assert.equal(q.noCapacity, true);
});
test("findQueueSignal：queueCount:5（有人在等位）→ 真排队非无容量", () => {
  const q = findQueueSignal(JSON.parse(inner10605NoCap({ queueCount: 5 })));
  assert.equal(q.noCapacity, false);
});
test("retryAfterFrom：多层转义里提到 retryAfterSeconds:30", () => {
  assert.equal(retryAfterFrom(wrapped403Body()).retryAfter, 30);
});

// ---- 真机四层转义回归（2026-10-22 13:53 现网取证，reqId=mvj4jpsd）----
// 上游真实字节是 {"error":{"message":"{\"code\":\"403\",\"message\":\"{\\\"code\\\":\\\"10605\\\",…}"}
// 四层嵌套：引号逐层翻倍转义。旧实现带引号正则在非最内层永远打不中，且下钻撞限深顶 → 判决漏检，
// 403 被当普通 auth 直出。修复 = isQueueSignal/isNoCapacitySignal 判决前剥反斜杠归一（同 retryAfterFrom）。
const real403Body = () => {
  const l4 = JSON.stringify({ isQueued: true, modelKey: "qfmodel", queueCount: 0, queueType: "p3", retryAfterSeconds: 30, serviceAvailable: false, subCode: "RESOURCE_LIMIT" });
  const l3 = JSON.stringify({ code: "10605", message: l4 });
  const l2 = JSON.stringify({ code: "403", message: l3 });
  return JSON.stringify({ error: { message: l2 } });
};
test("findQueueSignal：真机四层转义 body（字符串层）→ 命中 noCapacity=true", () => {
  const q = findQueueSignal(real403Body());
  assert.ok(q, "四层转义信封必须在字符串层或下钻中命中");
  assert.equal(q.code, "10605");
  assert.equal(q.noCapacity, true);
});
test("findQueueSignal：真机四层转义 body（先 parse 再对象层）同样命中", () => {
  const q = findQueueSignal(JSON.parse(real403Body()));
  assert.equal(q?.noCapacity, true);
});
test("真机形态端到端：HTTP403 四层转义无容量 → 429 + Retry-After:30 + 只撞一个号", async () => {
  let chatCalls = 0;
  const fetchImpl = async () => {
    chatCalls++;
    return new Response(real403Body(), { status: 403, headers: { "content-type": "application/json" } });
  };
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-qoder-real-"));
  const p = createQoderProvider({ id: "qoder", apiKeys: [blob("dt-a"), blob("dt-b"), blob("dt-c")], file: join(dir, "s.json"), fetchImpl, cooldownMs: 1, queueCooldownMs: 60000 });
  try {
    const res = await p.chat(reqBody, { reqId: "real1" });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("Retry-After"), "30");
    assert.equal(res.headers.get("x-mslxdff-qoder-nocapacity"), "1");
    // 判决定点日志（2026-10-22 补）：403 盲飞的根因是日志只写状态码，看不出判决命中哪种。
    // 现每条出口都钉 verdict 头，管线落进 qoder-<model>.log，grep verdict= 一眼定位。
    assert.equal(res.headers.get("x-mslxdff-qoder-verdict"), "queue-nocapacity", "判决结果须显式钉头供日志取证");
    assert.equal(chatCalls, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("回归：普通 403（无 10605/110/105 信号）verdict=none，仍走原鉴权冷却路径", async () => {
  let chatCalls = 0;
  const fetchImpl = async () => {
    chatCalls++;
    return new Response(JSON.stringify({ error: { message: "forbidden" } }), { status: 403, headers: { "content-type": "application/json" } });
  };
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-qoder-none-"));
  const p = createQoderProvider({ id: "qoder", apiKeys: [blob("dt-a"), blob("dt-b")], file: join(dir, "s.json"), fetchImpl, cooldownMs: 1, queueCooldownMs: 60000 });
  try {
    const res = await p.chat(reqBody, { reqId: "none1" });
    assert.equal(res.headers.get("x-mslxdff-qoder-verdict"), "none", "没命中任何判决必须显式落 none");
    assert.equal(res.headers.get("x-mslxdff-qoder-nocapacity"), null, "none 不得误挂无容量旗标");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 真机判决链根因（2026-10-22 14:31 reqId=mvj5y39r）：isLoginExpired 旧正则 /"code":"105"?/ 无数字边界，
// 排队码 "10605" 前缀 105 被误命中 → verdictFlagsFrom 永远先走 login 分支 → noCapacity 判决根本轮不到，
// 403 直出。修复 = 加 (?![0-9]) 数字边界。此例锁死「排队 body 不得被判 login」。
test("回归：真机四层排队 body 不得被 findLoginSignal 误判（10605 前缀 105 陷阱）", () => {
  const l4 = JSON.stringify({ isQueued: true, queueCount: 0, serviceAvailable: false, subCode: "RESOURCE_LIMIT" });
  const body = JSON.stringify({ error: { message: JSON.stringify({ code: "403", message: JSON.stringify({ code: "10605", message: l4 }) }) } });
  assert.equal(findLoginSignal(body), null, "排队 body 不能命中 login");
  assert.equal(isLoginExpired("10605", ""), false, "容器码 10605 非登录过期");
  assert.equal(isLoginExpired("", body), false, "四层转义 body 含 code:10605 不得前缀误伤 105");
});
test("回归：真登录过期（code 105）仍命中 login", () => {
  const body105 = JSON.stringify({ error: { message: JSON.stringify({ code: "105", message: "Login expired" }) } });
  assert.ok(findLoginSignal(body105), "真 105 必须命中 login（边界修复不得误伤真值）");
  assert.ok(isLoginExpired("105", ""), "裸 code 105 命中");
});

// ---- 门面端到端：无容量不换号轮询 ----
test("门面：HTTP403 无容量 → 只撞一个号（不轮询整池）→ 429 + Retry-After", async () => {
  let chatCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("/deviceToken/refresh")) return new Response("x", { status: 401 });
    chatCalls++;
    return new Response(wrapped403Body(), { status: 403, headers: { "content-type": "application/json" } });
  };
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-qoder-nc-"));
  const p = createQoderProvider({ id: "qoder", apiKeys: [blob("dt-a"), blob("dt-b"), blob("dt-c")], file: join(dir, "s.json"), fetchImpl, cooldownMs: 1, queueCooldownMs: 60000 });
  try {
    const res = await p.chat(reqBody, { reqId: "nc1" });
    assert.equal(res.status, 429, "无容量应回 429（非换号轮询后的 403 透传）");
    assert.equal(res.headers.get("Retry-After"), "30", "带上游 retryAfterSeconds");
    assert.equal(res.headers.get("x-mslxdff-qoder-nocapacity"), "1");
    assert.equal(chatCalls, 1, "同 p3 队列换号无意义：只撞一个号即停");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("门面：真排队（queueCount>0）仍换号碰别的号（不误并入无容量档）", async () => {
  let chatCalls = 0;
  const fetchImpl = async () => {
    chatCalls++;
    const body = JSON.stringify({ code: "403", message: JSON.stringify({ isQueued: true, queueCount: 3, serviceAvailable: true, retryAfterSeconds: 30 }) });
    return new Response(body, { status: 403, headers: { "content-type": "application/json" } });
  };
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-qoder-q-"));
  const p = createQoderProvider({ id: "qoder", apiKeys: [blob("dt-a"), blob("dt-b")], file: join(dir, "s.json"), fetchImpl, cooldownMs: 1, queueCooldownMs: 60000 });
  try {
    await p.chat(reqBody, { reqId: "nc2" });
    assert.ok(chatCalls >= 2, "queueCount>0 → 换号各撞，最多轮完池子");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
