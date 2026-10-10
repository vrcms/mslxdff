// raccoon 转发链路单测：出站体构造、思考开关、失败分类、SSE 聚合、注册与启用门禁。
// 全部注入 fetchImpl，不碰真实上游；state 指向临时文件，不碰真实 state。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MSLXDFF_STATE_FILE = join(mkdtempSync(join(tmpdir(), "mslxdff-raccoon-chat-")), "state.json");

const { buildRaccoonWireBody, forwardRaccoonChat } = await import("../src/providers/raccoon/chat.js");
const { classifyRaccoonFailure, raccoonErrorResponse, aggregateRaccoonSse } = await import("../src/providers/raccoon/sse.js");
const { createRaccoonProvider } = await import("../src/providers/raccoon/index.js");
const { raccoonThinkingType } = await import("../src/providers/raccoon/const.js");
const { getCustomProviderFactory } = await import("../src/providers/registry.js");
const { shouldEnableCustomProvider, AUTH_DOC_PROVIDER_IDS } = await import("../src/runtime/provider-gate.js");
const { parseRaccoonCatalog, raccoonMultiplierLabel, raccoonDisplayName, seedRaccoonAllowlist } = await import("../src/providers/raccoon/models.js");

const fakeRes = (body, { status = 200, contentType = "application/json", stream = "STREAM" } = {}) => ({
  ok: status < 400,
  status,
  headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? contentType : null) },
  json: async () => JSON.parse(body),
  text: async () => body,
  body: stream,
});

test("wire body: 剥 raccoon/ 前缀 + 注入 extra_body.thinking，且绝不发 reasoning_effort", () => {
  const w = buildRaccoonWireBody({ model: "raccoon/sn-kimi-k3", messages: [], reasoning_effort: "high" });
  assert.equal(w.model, "sn-kimi-k3");
  assert.equal(w.extra_body.thinking.type, "enabled");
  assert.ok(!("reasoning_effort" in w), "不得向上游发送 reasoning_effort");
  const off = buildRaccoonWireBody({ model: "sn-glm-5-3" }, { effort: "off" });
  assert.equal(off.extra_body.thinking.type, "disabled");
  assert.equal(off.model, "sn-glm-5-3");
});

test("思考档位: 只有开/关两档，非本家档位归一为「开」", () => {
  assert.equal(raccoonThinkingType("on"), "enabled");
  assert.equal(raccoonThinkingType("off"), "disabled");
  assert.equal(raccoonThinkingType("none"), "disabled");
  assert.equal(raccoonThinkingType(undefined), "enabled");
  for (const lvl of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(raccoonThinkingType(lvl), "enabled", `${lvl} 应归一为 enabled`);
  }
});

test("失败分类: 401/200003 → auth；积分措辞 → quota；429 → rate_limit；5xx → server", () => {
  assert.equal(classifyRaccoonFailure(401, { code: 200001 }).kind, "auth");
  assert.equal(classifyRaccoonFailure(200, { code: 200003 }).kind, "auth");
  assert.equal(classifyRaccoonFailure(200, { code: 400001, message: "积分不足" }).kind, "quota");
  assert.equal(classifyRaccoonFailure(200, { code: 400002, message: "insufficient quota" }).kind, "quota");
  assert.equal(classifyRaccoonFailure(429, { code: 0, message: "too many" }).kind, "rate_limit");
  assert.equal(classifyRaccoonFailure(503, {}).kind, "server");
  assert.equal(classifyRaccoonFailure(400, { code: 123, message: "bad param" }).kind, "unknown");
});

test("错误响应: 带 x-mslxdff-raccoon-kind 且人话不谎报额度", async () => {
  const quota = raccoonErrorResponse({ kind: "quota", message: "积分不足" });
  assert.equal(quota.status, 429);
  assert.equal(quota.headers.get("x-mslxdff-raccoon-kind"), "quota");
  const rate = raccoonErrorResponse(classifyRaccoonFailure(429, { message: "slow down" }));
  assert.equal(rate.headers.get("x-mslxdff-raccoon-kind"), "rate_limit");
  assert.ok(!/积分/.test((await rate.json()).error.message), "限流不得谎报成积分不足");
});


test("SSE 聚合: content / reasoning_content / usage / finish_reason 都收得住", async () => {
  const sse = [
    'data: {"id":"c1","choices":[{"delta":{"reasoning_content":"想"},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{"content":"世界"},"finish_reason":"stop"}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4}}',
    "data: [DONE]",
    "",
  ].join("\n\n");
  const out = await aggregateRaccoonSse(sse, { model: "sn-kimi-k3" });
  assert.equal(out.openAi.choices[0].message.content, "你好世界");
  assert.equal(out.openAi.choices[0].message.reasoning_content, "想");
  assert.equal(out.openAi.choices[0].finish_reason, "stop");
  assert.equal(out.openAi.usage.completion_tokens, 4);
  assert.equal(out.openAi.model, "sn-kimi-k3");
});

test("SSE 聚合: 流内错误信封按失败分类返回，不静默成空回复", async () => {
  const out = await aggregateRaccoonSse('data: {"code":200003,"message":"登录已过期"}', {});
  assert.equal(out.error.kind, "auth");
});

test("forward: 非流式 JSON 直接透传；SSE 透传；JSON 信封 code!=0 判失败", async () => {
  const ok = await forwardRaccoonChat({
    body: { model: "raccoon/sn-kimi-k3", stream: false },
    credential: { access_token: "t" },
    fetchImpl: async () => fakeRes('{"choices":[{"message":{"content":"hi"}}]}'),
  });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(await ok.text()).choices[0].message.content, "hi");

  const sse = await forwardRaccoonChat({
    body: { model: "sn-kimi-k3", stream: true },
    credential: { access_token: "t" },
    fetchImpl: async () => fakeRes("data: {}\n\n", { contentType: "text/event-stream" }),
  });
  assert.equal(sse.headers.get("Content-Type"), "text/event-stream; charset=utf-8");

  const bad = await forwardRaccoonChat({
    body: { model: "sn-kimi-k3", stream: true },
    credential: { access_token: "t" },
    fetchImpl: async () => fakeRes('{"code":200003,"message":"登录已过期"}'),
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get("x-mslxdff-raccoon-kind"), "auth");
});

test("forward: header 说是 JSON 但体是 SSE 帧 → 按形状判定（参考实现踩过的坑）", async () => {
  const sseText = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const streamed = await forwardRaccoonChat({
    body: { model: "sn-kimi-k3", stream: true },
    credential: { access_token: "t" },
    fetchImpl: async () => fakeRes(sseText, { contentType: "application/json" }),
  });
  assert.equal(streamed.headers.get("Content-Type"), "text/event-stream; charset=utf-8");

  const agg = await forwardRaccoonChat({
    body: { model: "sn-kimi-k3", stream: false },
    credential: { access_token: "t" },
    fetchImpl: async () => fakeRes(sseText, { contentType: "application/json" }),
  });
  assert.equal(JSON.parse(await agg.text()).choices[0].message.content, "ok");
});

test("forward: 网络异常 → 502 upstream_error（不抛到调用方）", async () => {
  const res = await forwardRaccoonChat({
    body: { model: "sn-kimi-k3" },
    credential: { access_token: "t" },
    fetchImpl: async () => { throw new Error("ECONNRESET"); },
  });
  assert.equal(res.status, 502);
  assert.match(JSON.parse(await res.text()).error.message, /ECONNRESET/);
});

test("registry 与门禁: raccoon 已注册；auth 号型（无 baseUrl、无 keys 但 auths 有号）也启用", async () => {
  const factory = await getCustomProviderFactory("raccoon", "");
  assert.equal(typeof factory, "function");
  const byUrl = await getCustomProviderFactory("whatever", "https://xiaohuanxiong.com/api/web/llm/v2");
  assert.equal(typeof byUrl, "function");
  assert.ok(AUTH_DOC_PROVIDER_IDS.includes("raccoon"), "raccoon 必须在 AUTH_DOC_PROVIDER_IDS 里，否则会被静默跳过");
  assert.equal(shouldEnableCustomProvider("raccoon", { hasAuthDocs: true }), true);
  assert.equal(shouldEnableCustomProvider("raccoon", {}), false);
});

test("工厂: 无号时 chat 返回 401 + login 指引；listModels 无号返回空", async () => {
  const provider = createRaccoonProvider({ apiKeys: ["tok-a"], fetchImpl: async () => fakeRes("{}") });
  assert.equal(provider.id, "raccoon");
  assert.equal(typeof provider.chat, "function");
  assert.equal(typeof provider.chatWithKeys, "function");
  assert.equal(provider.baseUrl, "raccoon://native");
  const empty = createRaccoonProvider({ file: join(tmpdir(), "no-such-raccoon-state.json") });
  const res = await empty.chat({ model: "raccoon/sn-kimi-k3" });
  assert.equal(res.status, 401);
  assert.match(JSON.parse(await res.text()).error.message, /login/);
  assert.deepEqual(await empty.listModels(), []);
});

test("目录: 解析容错 + 倍率文案（免费/x1/促销）+ 兜底目录补齐 allowlist", () => {
  const models = parseRaccoonCatalog({
    models: [
      { modelId: "sn-kimi-k3", modelName: "Kimi-K3", contextWindow: 1_000_000, maxTokens: 100_000, supportsImage: true, effectiveMultiplier: 1 },
      { id: "sn-free", effective_multiplier: 0, context_window: 256000 },
      { id: "sn-promo", effectiveMultiplier: 0.1, baseMultiplier: 0.2 },
      { nonsense: true },
    ],
  });
  assert.equal(models.length, 3, "无 id 的条目应被丢弃");
  assert.equal(raccoonMultiplierLabel(models[0]), "x1", "x1 也必须显示，不能被省略");
  assert.equal(raccoonMultiplierLabel(models[1]), "免费");
  assert.equal(raccoonMultiplierLabel(models[2]), "x0.2→x0.1");
  assert.equal(raccoonDisplayName(models[0]), "Kimi-K3 · x1");
  assert.equal(raccoonDisplayName({ id: "sn-x" }), "sn-x", "无倍率时后缀应省略");
  const seeded = seedRaccoonAllowlist({ ids: ["sn-kimi-k3", "sn-glm-5-3"] });
  assert.deepEqual(seeded.added, ["sn-kimi-k3", "sn-glm-5-3"]);
  const again = seedRaccoonAllowlist({ ids: ["sn-kimi-k3"] });
  assert.deepEqual(again.added, [], "只增不减：已有项不再重复添加");
});
