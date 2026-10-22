// qoder-wire-align.test.js — 对齐官方 qodercli / 外部参考（dsh-qoder-connect、magpie qoder 插件）后的新行为锁定
// ① messages 发 Qoder 原生形状（user=contents[]、assistant 回传 reasoning_content、不再注入模板示例历史）；
// ② session_id 按对话稳定（prompt 缓存亲和的关键：同对话恒定、异对话不同）；
// ③ cache_control ephemeral 打在最后一个可缓存块；末轮 tool 不标；
// ④ business.id = request_set_id（排队条目关联）；
// ⑤ 身份头 = qodercli 口径（UA qoder/x.y.z；无 cosy-scene/business-* 旧 IDE 指纹；补 bodyhash/sigpath/machineos/x-request-id）；
// ⑥ 多窗口模型按请求大小升档 context_length；模型声明档位对齐（不发明细。
import { test } from "node:test";
import assert from "node:assert/strict";
import { toQoderWireMessages, buildQoderBody, conversationSessionId, cacheMark } from "../src/providers/qoder/payload.js";
import { buildUpstreamRequest } from "../src/providers/qoder/request.js";
import { buildCosyHeaders, newSession } from "../src/providers/qoder/session.js";
import { cosyDecode } from "../src/providers/qoder/encode.js";

const mkSess = () => newSession(
  { name: "t", aid: "u1", uid: "u1", yxUid: "", organizationId: "", organizationName: "", userType: "personal_standard", securityOauthToken: "dt-x", refreshToken: "" },
  "mid", "mtok", "mt",
);
const decodeReq = (bodyStr) => JSON.parse(cosyDecode(String(bodyStr)).toString("utf8"));

// ---- ① 原生 wire 形状 ----
test("wire：user 消息 → contents[] 数组（官方形状，非 OpenAI 原样透传）", () => {
  const w = toQoderWireMessages([{ role: "user", content: "hi" }]);
  assert.equal(w[0].role, "system"); // 官方人格恒前置
  assert.match(w[0].content, /^You are a Qoder agent/);
  const user = w[1];
  assert.equal(user.role, "user");
  assert.deepEqual(user.contents, [{ type: "text", text: "hi" }]);
  assert.ok(user.response_meta, "response_meta 骨架在");
});
test("wire：不再注入 vendored 模板示例历史（无 'hi' 示例、无假环境块）", () => {
  const { body } = buildQoderBody({ userId: "u1", model: "qfmodel", messages: [{ role: "user", content: "只发这一条" }] });
  assert.equal(body.messages.length, 2, "system 人格 + 本轮 user");
  assert.equal(body.messages[1].contents[0].text, "只发这一条");
  assert.ok(!JSON.stringify(body.messages).includes("Working directory"), "假环境信息不得出门");
});
test("wire：assistant 历史回传 reasoning_content 与 tool_calls；tool 行保留 tool_call_id", () => {
  const w = toQoderWireMessages([
    { role: "user", content: "q" },
    { role: "assistant", content: "a", reasoning_content: "think", tool_calls: [{ id: "c1", type: "function", function: { name: "X", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "res" },
  ]);
  const asst = w[2];
  assert.equal(asst.reasoning_content, "think");
  assert.equal(asst.tool_calls[0].id, "c1");
  assert.equal(w[3].role, "tool");
  assert.equal(w[3].tool_call_id, "c1");
});
test("wire：Anthropic 风格 image 块 → image_url part；OpenAI 数组 content 保留多块", () => {
  const w = toQoderWireMessages([
    { role: "user", content: [{ type: "text", text: "看这个" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
  ]);
  const parts = w[1].contents;
  assert.equal(parts.length, 2);
  assert.equal(parts[1].type, "image_url");
  assert.equal(parts[1].image_url.url, "data:image/png;base64,AAAA");
});
test("wire：客户端 system 拼在官方人格之后（人格行前置为缓存稳定种子）", () => {
  const w = toQoderWireMessages([{ role: "system", content: "S" }, { role: "user", content: "q" }]);
  assert.match(w[0].content, /^You are a Qoder agent.*\bS\b/s);
});

// ---- ①b tool 配对修复（上游整体拒绝孤儿 result）----
const call = (id) => ({ role: "assistant", content: "", tool_calls: [{ ...(id === undefined ? {} : { id }), type: "function", function: { name: "f", arguments: "{}" } }] });
const callTwo = () => ({ role: "assistant", content: "", tool_calls: [
  { id: "a", type: "function", function: { name: "f", arguments: "{}" } },
  { id: "b", type: "function", function: { name: "g", arguments: "{}" } },
] });
const result = (id, content = "ok") => ({ role: "tool", ...(id === undefined ? {} : { tool_call_id: id }), content });

test("pairing：call 丢 id → result 点名认领，双方同一 id", () => {
  const w = toQoderWireMessages([{ role: "user", content: "r" }, call(undefined), result("c1")]);
  const t = w.find((m) => m.role === "tool");
  assert.equal(t.content, "ok");
  assert.deepEqual(w.find((m) => m.role === "assistant").tool_calls.map((c) => c.id), [t.tool_call_id]);
});
test("pairing：双方都丢 id → 仍配对成 tool 行", () => {
  const w = toQoderWireMessages([{ role: "user", content: "r" }, call(undefined), result(undefined, "myhost")]);
  assert.equal(w.at(-1).role, "tool");
  assert.equal(w.at(-1).content, "myhost");
});
test("pairing：多 call 丢 id 的 result 按发出顺序认领", () => {
  const w = toQoderWireMessages([{ role: "user", content: "r" }, { role: "assistant", content: "", tool_calls: [
    { type: "function", function: { name: "f", arguments: "{}" } },
    { type: "function", function: { name: "g", arguments: "{}" } },
  ] }, result(undefined, "A"), result(undefined, "B")]);
  const ids = w.find((m) => m.role === "assistant").tool_calls.map((c) => c.id);
  assert.deepEqual(w.filter((m) => m.role === "tool").map((m) => m.tool_call_id), ids);
});
test("pairing：孤儿 result 点名合法 call 时只能认领未被点名的（防抢占）", () => {
  const w = toQoderWireMessages([{ role: "user", content: "r" }, callTwo(), result("lost", "B"), result("a", "A")]);
  const tools = w.filter((m) => m.role === "tool");
  assert.deepEqual(tools.map((m) => [m.tool_call_id, m.content]), [["b", "B"], ["a", "A"]]);
});
test("pairing：无路可认领的孤儿 result 降级 user 文本，内容不丢", () => {
  const w = toQoderWireMessages([{ role: "user", content: "hi" }, result("gone", "the words")]);
  assert.equal(w.filter((m) => m.role === "tool").length, 0);
  assert.ok(JSON.stringify(w).includes("the words"));
});

// ---- ② session_id 对话稳定 ----
test("session_id：同对话跨轮恒定（prompt 缓存亲和），不同对话不同名", () => {
  const sys = [{ role: "system", content: "S" }, { role: "user", content: "第一问" }];
  const a = conversationSessionId("u1", "qfmodel", toQoderWireMessages(sys));
  const b = conversationSessionId("u1", "qfmodel", toQoderWireMessages([...sys, { role: "assistant", content: "答" }, { role: "user", content: "追问" }]));
  const c = conversationSessionId("u1", "qfmodel", toQoderWireMessages([{ role: "system", content: "S" }, { role: "user", content: "另一个问题" }]));
  assert.equal(a, b, "同一对话（system+首 user 同）必须同名");
  assert.notEqual(a, c, "不同首问必须不同名");
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
});

// ---- ③ cache_control 标记 ----
test("cacheMark：末 user 轮最后一个文本块打 ephemeral；末轮是 tool 不标", () => {
  const marked = cacheMark(toQoderWireMessages([{ role: "user", content: "hello" }]));
  const last = marked.at(-1).contents.at(-1);
  assert.deepEqual(last.cache_control, { type: "ephemeral" });
  const toolLast = cacheMark(toQoderWireMessages([
    { role: "user", content: "hi" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "X", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "r" },
  ]));
  assert.ok(!("cache_control" in (toolLast.at(-1).contents?.at(-1) || {})), "末轮 tool 结果不得标");
});

// ---- ④ business.id = request_set_id ----
test("business.id 必须 = request_set_id（排队条目关联）", () => {
  const { body } = buildQoderBody({ userId: "u1", model: "qfmodel", messages: [{ role: "user", content: "x" }] });
  assert.equal(body.business.id, body.request_set_id);
  assert.equal(body.business.product, "cli");
});

// ---- ⑤ 身份头 ----
test("headers：qodercli 口径（UA=qoder/…；旧 IDE 指纹头摘除；补 bodyhash/sigpath/x-request-id）", () => {
  const req = buildUpstreamRequest({ sess: mkSess(), region: "global", model: "qfmodel", messages: [{ role: "user", content: "hi" }], tools: null, maxTokens: 0, isReasoning: false });
  const h = req.headers;
  assert.match(h["user-agent"], /^qoder\/\d+\.\d+\.\d+$/);
  assert.ok(!("cosy-scene" in h) && !("cosy-business-product" in h) && !("cosy-business-type" in h), "IDE 伪装头不得出门");
  assert.ok(h["cosy-bodyhash"] && h["cosy-bodylength"] && h["cosy-sigpath"], "参考实现真值头补齐");
  assert.ok(h["cosy-machineos"], "machineos 在");
  assert.ok(h["x-request-id"], "x-request-id 在");
  assert.equal(h["cosy-data-policy"], "disagree");
});
test("headers：GET 类（空 body）签名与 bodyhash 语义不变（models 路径）", () => {
  const headers = buildCosyHeaders(mkSess(), "/api/v2/model/list", "", "application/json");
  assert.equal(headers["cosy-bodylength"], "0");
  assert.match(headers["cosy-bodyhash"], /^[0-9a-f]{32}$/);
});

// ---- ⑥ 窗口/档位（meta 驱动，仅声明时发）----
test("meta.context_windows：请求装得下默认 → 默认档；装不下 → 升最小可容纳档", () => {
  const small = buildQoderBody({ userId: "u1", model: "qfmodel", messages: [{ role: "user", content: "短" }],
    meta: { context_windows: [200000, 400000, 1000000], default_window: 200000 } }).body;
  assert.equal(small.parameters.context_length, 200000);
  const big = buildQoderBody({ userId: "u1", model: "qfmodel", messages: [{ role: "user", content: "x".repeat(2_000_000) }],
    meta: { context_windows: [200000, 400000, 1000000], default_window: 200000 } }).body;
  assert.ok(big.parameters.context_length > 200000, "超大请求必须升档");
});
test("meta.reasoning_efforts：isReasoning+要档位 → 对齐模型档位（不发明细）；未声明 → enable_thinking 单标", () => {
  const b = buildQoderBody({ userId: "u1", model: "m", messages: [{ role: "user", content: "x" }], isReasoning: true, effort: "high",
    meta: { reasoning_efforts: ["low", "medium"], default_reasoning_effort: "medium" } }).body;
  assert.equal(b.parameters.enable_thinking, true);
  assert.equal(b.parameters.reasoning_effort, "medium", "high 不在声明里 → 就近取高（medium）");
  const noEfforts = buildQoderBody({ userId: "u1", model: "m", messages: [{ role: "user", content: "x" }], isReasoning: true,
    meta: { context_length: 180000 } }).body;
  assert.equal(noEfforts.parameters.enable_thinking, true);
  assert.ok(!("reasoning_effort" in noEfforts.parameters), "无声明档位不得发明细");
});

// ---- 回退通道 ----
test("MSLXDFF_QODER_LEGACY_WIRE=1 → 恢复旧模板注入行为", () => {
  process.env.MSLXDFF_QODER_LEGACY_WIRE = "1";
  try {
    const { body } = buildQoderBody({ userId: "u1", model: "qfmodel", messages: [{ role: "user", content: "x" }], preserveTemplateHistory: true });
    assert.ok(body.messages[0]?.role === "system" && body.messages.length > 1, "旧形状：模板 system 前置");
  } finally {
    delete process.env.MSLXDFF_QODER_LEGACY_WIRE;
  }
});
