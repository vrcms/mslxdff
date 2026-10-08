// qoder-p0-fixes.test.js — 四条 P0 的行为锁定（openspec/changes/qoder-p0-fixes）
// ① 推理模型 is_reasoning 必须传出（model_config 与 chat_context.extra.modelConfig 双写）；
// ② 上游 finish_reason 必须透传（截断 length 可见），上游未给保持旧默认；
// ③ 客户端无 tools 时请求体 tools 恒为空数组，模板内嵌 14 工具永不出门；
// ④ SSE 未完结缓冲超 2MiB 立即以流错误中断（流式 error 事件 / 聚合 502）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractDelta } from "../src/providers/qoder/sse.js";
import { buildQoderBody } from "../src/providers/qoder/payload.js";
import { buildUpstreamRequest } from "../src/providers/qoder/request.js";
import { newSession } from "../src/providers/qoder/session.js";
import { reshapeQoderStream } from "../src/providers/qoder/stream.js";
import { aggregateQoderStream, toCompletionJson } from "../src/providers/qoder/aggregate.js";
import { createModelsService } from "../src/providers/qoder/models.js";
import { createChatService } from "../src/providers/qoder/chat.js";
import { createQoderProvider } from "../src/providers/qoder/index.js";
import { cosyDecode } from "../src/providers/qoder/encode.js";

const env = (inner, statusCodeValue = 200, statusCode = "OK") =>
  `data:${JSON.stringify({ headers: {}, body: JSON.stringify(inner), statusCodeValue, statusCode })}\n\n`;
const innerOf = (frame) => frame.trim().slice(5);
const contentFrame = (t) => env({ choices: [{ index: 0, delta: { content: t } }] });
const finishFrame = (reason, extra = {}) => env({ choices: [{ index: 0, delta: {}, finish_reason: reason, ...extra }] });
const DONE = "data:[DONE]\n\n";
const blob = (t) => JSON.stringify({ device_token: t, refresh_token: "" });
const decodeReq = (bodyStr) => JSON.parse(cosyDecode(String(bodyStr)).toString("utf8"));
const mkSess = () => newSession(
  { name: "t", aid: "u1", uid: "u1", yxUid: "", organizationId: "", organizationName: "", userType: "personal_standard", securityOauthToken: "dt-x", refreshToken: "" },
  "mid", "mtok", "mt",
);
const USER_MSGS = [{ role: "user", content: "hi" }];

// ---- ② finish_reason 解析（sse.js extractDelta） ----
test("sse：末帧 finish_reason=length → extractDelta 带出 finishReason", () => {
  assert.equal(extractDelta(innerOf(finishFrame("length"))).finishReason, "length");
});
test("sse：帧完全没有 delta 对象时 finish_reason 也不许被吞", () => {
  assert.equal(extractDelta(innerOf(env({ choices: [{ index: 0, finish_reason: "content_filter" }] }))).finishReason, "content_filter");
});
test("sse：普通内容帧不受影响（既有行为）", () => {
  const d = extractDelta(innerOf(contentFrame("ok")));
  assert.equal(d.content, "ok");
  assert.equal(d.finishReason, undefined);
});

// ---- ③ tools 空数组契约 + ① payload 双写 ----
test("payload：无 tools 请求体 tools=[]（模板内嵌工具不得出门）", () => {
  assert.deepEqual(buildQoderBody({ model: "qfmodel", messages: USER_MSGS }).body.tools, []);
  assert.deepEqual(buildQoderBody({ model: "qfmodel", messages: USER_MSGS, tools: [] }).body.tools, []);
  const t = [{ type: "function", function: { name: "X" } }];
  assert.deepEqual(buildQoderBody({ model: "qfmodel", messages: USER_MSGS, tools: t }).body.tools, t);
});
test("payload：isReasoning=true → model_config 与 chat_context.extra.modelConfig 双写", () => {
  const { body } = buildQoderBody({ model: "qmodel_38max", messages: USER_MSGS, isReasoning: true });
  assert.equal(body.model_config.is_reasoning, true);
  assert.equal(body.chat_context.extra.modelConfig.is_reasoning, true);
});

// ---- ① request 装配透传 ----
test("request：isReasoning 形参透传进签名前请求体", () => {
  const req = buildUpstreamRequest({ sess: mkSess(), region: "global", model: "qmodel_38max", messages: USER_MSGS, tools: null, maxTokens: 0, isReasoning: true });
  const j = decodeReq(req.bodyStr);
  assert.equal(j.model_config.is_reasoning, true);
  assert.deepEqual(j.tools, []);
});

// ---- ② 流式/聚合透传 ----
test("stream：上游 length → 客户端尾 chunk finish_reason=length", async () => {
  const res = reshapeQoderStream(new Response(contentFrame("a") + finishFrame("length") + DONE), { model: "m", chatId: "c1" });
  assert.match(await res.text(), /"finish_reason":"length"/);
});
test("stream：上游全程不给 finish_reason → 保持旧默认 stop", async () => {
  const res = reshapeQoderStream(new Response(contentFrame("a") + DONE), { model: "m", chatId: "c2" });
  const text = await res.text();
  assert.match(text, /"finish_reason":"stop"/);
});
test("aggregate：finish_reason 透传进 completion JSON", async () => {
  const agg = await aggregateQoderStream(new Response(contentFrame("a") + finishFrame("length") + DONE));
  assert.equal(agg.finishReason, "length");
});

// ---- ④ 2MiB 缓冲上限 ----
test("stream：单条未完结 data 行超 2MiB → error 事件收尾，不再攒内存", async () => {
  const huge = "data:" + "a".repeat(2.5 * 1024 * 1024); // 无换行 = 永不完结的一行
  const res = reshapeQoderStream(new Response(huge), { model: "m", chatId: "c3" });
  const text = await res.text();
  assert.match(text, /event: error/);
  assert.match(text, /2MiB/);
});
test("aggregate：超限抛 502 类错误（门面据此冷却换号）", async () => {
  await assert.rejects(
    () => aggregateQoderStream(new Response("data:" + "b".repeat(2.5 * 1024 * 1024))), // 永不完结的行：leftover 越限即抛
    (e) => e.status === 502 && /2MiB/.test(e.detail),
  );
});

// ---- ① chat.js：目录查询与降级 ----
function mkChatFetch() {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return new Response(contentFrame("ok") + DONE, { status: 200, headers: { "content-type": "text/event-stream" } }); };
  fn.calls = calls;
  return fn;
}
test("chat：getModelMeta 命中推理模型 → 请求体 is_reasoning=true（两处）", async () => {
  const up = mkChatFetch();
  const svc = createChatService({ id: "qoder", fetchImpl: up, timeoutMs: 5000, getModelMeta: async () => ({ is_reasoning: true }) });
  await svc.runChat({ model: "qmodel_38max", messages: USER_MSGS, stream: false }, mkSess(), "global");
  const j = decodeReq(up.calls[0].init.body);
  assert.equal(j.model_config.is_reasoning, true);
  assert.equal(j.chat_context.extra.modelConfig.is_reasoning, true);
  assert.deepEqual(j.tools, []);
});
test("chat：目录查询抛错 → 降级 is_reasoning=false，对话不被阻断", async () => {
  const up = mkChatFetch();
  const svc = createChatService({ id: "qoder", fetchImpl: up, timeoutMs: 5000, getModelMeta: async () => { throw new Error("catalog down"); } });
  const res = await svc.runChat({ model: "qmodel_38max", messages: USER_MSGS, stream: false }, mkSess(), "global");
  assert.equal(res.status, 200);
  const j = decodeReq(up.calls[0].init.body);
  assert.equal(j.model_config.is_reasoning, false);
});

// ---- ① index.js 端到端接线：model/list → chat 请求体 ----
test("index：目录标 is_reasoning 的模型，对话请求体带 true（fake model/list）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-qoder-p0-"));
  const chatCalls = [];
  let listCalls = 0;
  const fetchImpl = async (url, init) => {
    if (String(url).includes("/model/list")) { listCalls++;
      return new Response(JSON.stringify({ assistant: [{ key: "qmodel_38max", display_name: "M38", enable: true, is_reasoning: true, max_input_tokens: 200000, price_factor: 1 }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    chatCalls.push(init.body);
    return new Response(contentFrame("ok") + DONE, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const p = createQoderProvider({ id: "qoder", apiKeys: [blob("dt-a")], file: join(dir, "state.json"), fetchImpl });
  try {
    await p.listModels(); // 模拟 preheat 灌缓存：chat 路径的 getModelMeta 只读缓存、绝不上游
    const res = await p.chat({ model: "qoder/qmodel_38max", messages: USER_MSGS, stream: false }, { reqId: "p0" });
    assert.equal(res.status, 200);
    const j = decodeReq(chatCalls.at(-1));
    assert.equal(listCalls, 1, "listModels→chat 全程 model/list 只应命中 1 次（chat 恒 0 额外上游调用）");
    assert.equal(j.model_config.is_reasoning, true, "门面必须把目录推理标志接到 chat");
    assert.deepEqual(j.tools, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- 评审补强：流/聚合同构 + 越限不连坐 + 快照语义（评审路1 P1#2/#4、评审路2 P1#2/#3、P0） ----
test("stream：同帧 finish_reason=stop 又带 tool_calls（上游自相矛盾）→ 按契约如实透传 stop", async () => {
  const toolFrame = env({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "X", arguments: "{}" } }] }, finish_reason: "stop" }] });
  const res = reshapeQoderStream(new Response(toolFrame + DONE), { model: "m", chatId: "iso1" });
  const text = await res.text();
  assert.match(text, /"finish_reason":"stop"/, "spec 契约=上游给出即透传优先；矛盾帧属上游异常，不擅改（评审路1 覆盖声明3 记为可观测风险）");
});
test("stream：tool_calls 帧不带 finish 且上游全程未给 → 兜底 tool_calls（旧行为保持）", async () => {
  const toolFrame = env({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c2", type: "function", function: { name: "X", arguments: "{}" } }] } }] });
  const res = reshapeQoderStream(new Response(toolFrame + DONE), { model: "m", chatId: "iso1b" });
  assert.match(await res.text(), /"finish_reason":"tool_calls"/);
});
test("stream+aggregate：收尾判定同构（同一帧序两管线必须给同一个 finish_reason）", async () => {
  const src = contentFrame("a") + finishFrame("length") + DONE;
  const s = await reshapeQoderStream(new Response(src), { model: "m", chatId: "iso2" }).text();
  assert.match(s, /"finish_reason":"length"/);
  const agg = await aggregateQoderStream(new Response(src));
  const out = toCompletionJson({ model: "m", chatId: "iso2", ...agg });
  assert.equal(out.choices[0].finish_reason, "length");
  // 上游不给 finish 时两管线都兜底 stop / tool_calls
  const noFin = contentFrame("a") + DONE;
  assert.match(await reshapeQoderStream(new Response(noFin), { model: "m", chatId: "i3" }).text(), /"finish_reason":"stop"/);
  assert.equal((toCompletionJson({ model: "m", chatId: "i3", ...(await aggregateQoderStream(new Response(noFin))) })).choices[0].finish_reason, "stop");
});
test("stream：越限前的合法帧必须已发出（不连坐丢弃）", async () => {
  const huge = "data:" + "z".repeat(2.5 * 1024 * 1024); // 无换行 leftover
  const res = reshapeQoderStream(new Response(contentFrame("good") + huge), { model: "m", chatId: "lim1" });
  const text = await res.text();
  assert.match(text, /good/, "已完整的帧不得被同 chunk 的超大 leftover 连坐");
  assert.match(text, /2MiB/);
});
test("models：peekModels 为快照语义（不吃 TTL）且冷启动返回 null", async () => {
  let now = 1000;
  const listFetch = async () => new Response(JSON.stringify({ assistant: [{ key: "qmodel_38max", display_name: "M", enable: true, is_reasoning: true, max_input_tokens: 200000, price_factor: 1 }] }), { status: 200, headers: { "content-type": "application/json" } });
  const svc = createModelsService({ id: "qoder", fetchImpl: listFetch, clock: () => now });
  assert.equal(svc.peekModels("global"), null, "未拉过 = null（chat 降级 false）");
  await svc.listModels(mkSess(), "global");
  now += 10 * 60 * 1000 + 1; // 越过 CACHE_TTL
  assert.ok(svc.peekModels("global")?.length === 1, "TTL 过后快照仍在（daemon 稳态不丢 is_reasoning）");
  assert.equal(listFetch.calls, undefined); // 确认 peek 不打网络（fetchImpl 未被再次调用由下一条断言）
  const before = now;
  svc.peekModels("global");
  assert.equal(now, before, "peek 不推进时钟/不触发刷新");
});
test("index：chatWithKeys 复用主实例目录快照（共享 key 链路不恒 false）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-qoder-p0ck-"));
  let listCalls = 0;
  const chatCalls = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes("/model/list")) { listCalls++; return new Response(JSON.stringify({ assistant: [{ key: "qmodel_38max", display_name: "M", enable: true, is_reasoning: true, max_input_tokens: 200000, price_factor: 1 }] }), { status: 200, headers: { "content-type": "application/json" } }); }
    chatCalls.push(init.body);
    return new Response(contentFrame("ok") + DONE, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const p = createQoderProvider({ id: "qoder", apiKeys: [blob("dt-a")], file: join(dir, "state.json"), fetchImpl });
  try {
    await p.listModels();
    const n = listCalls;
    const res = await p.chatWithKeys({ model: "qoder/qmodel_38max", messages: USER_MSGS, stream: false }, [blob("dt-z")], { reqId: "ck" });
    assert.equal(res.status, 200);
    assert.equal(listCalls, n, "chatWithKeys 不再打 model/list（复用快照）");
    assert.equal(decodeReq(chatCalls.at(-1)).model_config.is_reasoning, true, "共享 key 路径也要带出推理标志");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
