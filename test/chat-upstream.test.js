import { test, describe } from "node:test";
import assert from "node:assert/strict";

// 红阶段：以下模块待实现
import { createDirectClient } from "../src/chat/direct.js";
import { createGatewayClient } from "../src/chat/gateway.js";
import { parseSse } from "../src/chat/sse.js";
import { createCooling } from "../src/chat/cooling.js";
import { createOrchestrator } from "../src/chat/orchestrator.js";

describe("C3 direct 去tools重试", () => {
  test("US1 tools→400 prompt 触发无tools重试并标记", async () => {
    let calls = 0;
    const seq = [
      { status: 400, body: { error: { message: "prompt too long" } } },
      { status: 200, body: { choices: [{ message: { role: "assistant", content: "ok" } }], usage: {} } },
    ];
    const fakeCreate = () => ({
      chat: async (body) => {
        calls++;
        const cur = seq[calls - 1];
        const txt = JSON.stringify(cur.body);
        return {
          status: cur.status,
          ok: cur.status < 400,
          text: async () => txt,
          headers: new Map(),
          clone: () => ({ text: async () => txt }),
        };
      },
      close: async () => {},
    });
    const { chatOnce } = createDirectClient({ createUpstreamClient: fakeCreate, chatTimeoutMs: 15000, env: process.env });
    const r = await chatOnce({ messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "t" } }], model: "mimo-v2.5-free" });
    assert.equal(r.ok, true);
    assert.equal(r.retriedWithoutTools, true);
    assert.equal(calls, 2, "应调用两次（带tools 400 + 去tools 200）");
  });

  test("US1 非prompt 400 不重试", async () => {
    const fakeCreate = () => ({
      chat: async () => ({
        status: 400, ok: false, text: async () => JSON.stringify({ error: { message: "other error" } }), headers: new Map(), clone: () => ({ text: async () => "{}" }),
      }),
      close: async () => {},
    });
    const { chatOnce } = createDirectClient({ createUpstreamClient: fakeCreate, chatTimeoutMs: 15000, env: process.env });
    const r = await chatOnce({ messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "t" } }], model: "x" });
    assert.equal(r.ok, false);
    assert.equal(r.retriedWithoutTools, undefined);
  });
});

describe("C3 sse 聚合", () => {
  test("US2 SSE 多行聚合 content+tool_calls", async () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hello " }, finish_reason: null }], model: "laguna-s-2.1-free" })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "search", arguments: "{\"q\":" } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"hi\"}" } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}`,
      `data: [DONE]`,
    ].join("\n");
    const agg = parseSse(sse);
    assert.equal(agg.content, "hello ");
    assert.equal(agg.toolCalls.length, 1);
    assert.equal(agg.toolCalls[0].function.name, "search");
    assert.equal(agg.toolCalls[0].function.arguments, "{\"q\":\"hi\"}");
    assert.equal(agg.model, "laguna-s-2.1-free");
  });

  test("US2 gateway SSE 兼容 via createGatewayClient", async () => {
    const sseText = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "gateway " } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}`,
      `data: [DONE]`,
    ].join("\n");
    const fakeFetch = async () => new Response(sseText, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const { chatViaGateway } = createGatewayClient({
      fetchImpl: fakeFetch,
      loadToken: async () => "tok",
      getPort: () => 8989,
      defaultPort: 8989,
      readModelsJson: async () => ({ data: [] }),
      gatewayTimeoutMs: 25000,
      env: { MSLXDFF_CHAT_TRACE: "0" },
    });
    const r = await chatViaGateway({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.ok, true);
    assert.match(r.message.content, /gateway hello/);
    assert.equal(r.viaGateway, true);
  });
});

describe("C3 gateway provider 回溯", () => {
  test("US3 裸模型 → opencode，workbuddy 前缀 → workbuddy", async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" } }], model: "laguna-s-2.1-free" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const { chatViaGateway } = createGatewayClient({
      fetchImpl: fakeFetch,
      loadToken: async () => "tok",
      getPort: () => 8989,
      defaultPort: 8989,
      readModelsJson: async () => ({ data: [{ id: "workbuddy/laguna-s-2.1-free" }, { id: "mimo-v2.5-free" }] }),
      gatewayTimeoutMs: 25000,
      env: { MSLXDFF_CHAT_TRACE: "0" },
    });
    const r = await chatViaGateway({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.provider, "workbuddy");
    // 裸模型
    const fakeFetch2 = async () =>
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" } }], model: "mimo-v2.5-free" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const { chatViaGateway: gw2 } = createGatewayClient({
      fetchImpl: fakeFetch2,
      loadToken: async () => "tok",
      getPort: () => 8989,
      defaultPort: 8989,
      readModelsJson: async () => ({ data: [{ id: "mimo-v2.5-free" }] }),
      gatewayTimeoutMs: 25000,
      env: { MSLXDFF_CHAT_TRACE: "0" },
    });
    const r2 = await gw2({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(r2.provider, "opencode");
  });
});

describe("C3 cooling 冷却", () => {
  test("US4 isCooling 10min 内 429 命中冷却", async () => {
    const now = Date.now();
    const store = new Map([["mimo-v2.5-free", { status: "limit", at: now - 1000, slow: false }]]);
    const { isCooling } = createCooling({
      loadModelErrors: () => Object.fromEntries(store),
      saveModelErrors: (o) => { store.clear(); Object.entries(o).forEach(([k, v]) => store.set(k, v)); },
      loadModelLatencies: () => ({}),
      saveModelLatencies: () => {},
      flush: () => {},
      now: () => now,
      cooldownMs: 10 * 60 * 1000,
      slowCooldownMs: 10 * 60 * 1000,
    });
    assert.equal(await isCooling("mimo-v2.5-free"), true);
    assert.equal(await isCooling("big-pickle"), false);
    // 超时后不再冷却
    const later = now + 11 * 60 * 1000;
    const { isCooling: isCool2 } = createCooling({
      loadModelErrors: () => Object.fromEntries(store),
      saveModelErrors: () => {},
      loadModelLatencies: () => ({}),
      saveModelLatencies: () => {},
      flush: () => {},
      now: () => later,
      cooldownMs: 10 * 60 * 1000,
      slowCooldownMs: 10 * 60 * 1000,
    });
    assert.equal(await isCool2("mimo-v2.5-free"), false);
  });
});

describe("C3 orchestrator 三级降级与对冲", () => {
  test("US5 mimo 429 → pickle 200 记录并回 fallback", async () => {
    const coolingStore = new Map();
    const cooling = createCooling({
      loadModelErrors: () => Object.fromEntries(coolingStore),
      saveModelErrors: (o) => { coolingStore.clear(); Object.entries(o).forEach(([k, v]) => coolingStore.set(k, v)); },
      loadModelLatencies: () => ({}),
      saveModelLatencies: () => {},
      flush: () => {},
      now: () => Date.now(),
      cooldownMs: 10 * 60 * 1000,
      slowCooldownMs: 10 * 60 * 1000,
    });
    let mimoCalls = 0, pickleCalls = 0;
    const fakeChatOnce = async ({ model }) => {
      if (model === "mimo-v2.5-free") { mimoCalls++; return { ok: false, error: "rate limit", status: 429 }; }
      if (model === "big-pickle") { pickleCalls++; return { ok: true, message: { role: "assistant", content: "pickle ok" }, status: 200 }; }
      return { ok: false, status: 500, error: "unknown" };
    };
    const fakeGateway = async () => ({ ok: false, error: "gateway not called", status: 500 });
    const { chatWithFallback } = createOrchestrator({
      chatOnce: fakeChatOnce,
      chatViaGateway: fakeGateway,
      cooling,
      config: { CHAT_PREFERRED: "mimo-v2.5-free", CHAT_FALLBACK: "big-pickle", CHAT_GATEWAY_TIMEOUT_MS: 25000 },
      env: { MSLXDFF_CHAT_TRACE: "0", MSLXDFF_HEDGE_DELAY_MS: "10" },
      performance,
    });
    const r = await chatWithFallback({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.ok, true);
    assert.equal(r.model, "big-pickle");
    assert.equal(mimoCalls, 1);
    assert.equal(pickleCalls, 1);
  });

  test("US6 800ms对冲 胶网关更快时网关胜", async () => {
    const cooling = createCooling({
      loadModelErrors: () => ({}),
      saveModelErrors: () => {},
      loadModelLatencies: () => ({}),
      saveModelLatencies: () => {},
      flush: () => {},
      now: () => Date.now(),
      cooldownMs: 10 * 60 * 1000,
      slowCooldownMs: 10 * 60 * 1000,
    });
    const fakeChatOnce = async ({ model }) => {
      if (model === "mimo-v2.5-free") return { ok: false, error: "fail", status: 500 };
      if (model === "big-pickle") { await new Promise((r) => setTimeout(r, 30)); return { ok: false, error: "slow fail", status: 500 }; }
      return { ok: false, status: 500, error: "x" };
    };
    const fakeGateway = async () => { await new Promise((r) => setTimeout(r, 5)); return { ok: true, message: { role: "assistant", content: "gw" }, model: "auto", provider: "opencode", viaGateway: true, status: 200 }; };
    const { chatWithFallback } = createOrchestrator({
      chatOnce: fakeChatOnce,
      chatViaGateway: fakeGateway,
      cooling,
      config: { CHAT_PREFERRED: "mimo-v2.5-free", CHAT_FALLBACK: "big-pickle", CHAT_GATEWAY_TIMEOUT_MS: 25000 },
      env: { MSLXDFF_CHAT_TRACE: "0", MSLXDFF_HEDGE_DELAY_MS: "10" },
      performance,
    });
    const r = await chatWithFallback({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.ok, true);
    assert.equal(r.viaGateway, true);
  });

  test("US7 双冷却直接网关", async () => {
    const now = Date.now();
    const store = new Map([
      ["mimo-v2.5-free", { status: "limit", at: now, slow: false }],
      ["big-pickle", { status: "limit", at: now, slow: false }],
    ]);
    const cooling = createCooling({
      loadModelErrors: () => Object.fromEntries(store),
      saveModelErrors: () => {},
      loadModelLatencies: () => ({}),
      saveModelLatencies: () => {},
      flush: () => {},
      now: () => now,
      cooldownMs: 10 * 60 * 1000,
      slowCooldownMs: 10 * 60 * 1000,
    });
    let directCalls = 0;
    const fakeChatOnce = async () => { directCalls++; return { ok: false, status: 500, error: "should not called" }; };
    const fakeGateway = async () => ({ ok: true, message: { role: "assistant", content: "gw2" }, model: "auto", status: 200, viaGateway: true });
    const { chatWithFallback } = createOrchestrator({
      chatOnce: fakeChatOnce,
      chatViaGateway: fakeGateway,
      cooling,
      config: { CHAT_PREFERRED: "mimo-v2.5-free", CHAT_FALLBACK: "big-pickle", CHAT_GATEWAY_TIMEOUT_MS: 25000 },
      env: { MSLXDFF_CHAT_TRACE: "0", MSLXDFF_HEDGE_DELAY_MS: "10" },
      performance,
    });
    const r = await chatWithFallback({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.ok, true);
    assert.equal(directCalls, 0, "双冷却时不应调直连");
  });

  test("US8 summarize 有内容回前缀 无内容回null", async () => {
    const fakeChat = async () => ({ ok: true, message: { content: "  summary text " } });
    const cooling = createCooling({
      loadModelErrors: () => ({}),
      saveModelErrors: () => {},
      loadModelLatencies: () => ({}),
      saveModelLatencies: () => {},
      flush: () => {},
      now: () => Date.now(),
      cooldownMs: 10 * 60 * 1000,
      slowCooldownMs: 10 * 60 * 1000,
    });
    const { summarizeHistory } = createOrchestrator({
      chatOnce: fakeChat,
      chatViaGateway: async () => ({ ok: false }),
      cooling,
      config: { CHAT_PREFERRED: "mimo-v2.5-free", CHAT_FALLBACK: "big-pickle", CHAT_GATEWAY_TIMEOUT_MS: 25000 },
      env: { MSLXDFF_CHAT_TRACE: "0", MSLXDFF_HEDGE_DELAY_MS: "10" },
      performance,
      // 覆盖 chatWithFallback 为 fakeChat
      _overrideChatWithFallback: fakeChat,
    });
    // 直接测 summarizeHistory via orchestrator 创建的版本
    const { createOrchestrator: cr2 } = await import("../src/chat/orchestrator.js");
    const fakeChatWithFallback = async () => ({ ok: true, message: { content: "compressed" } });
    const { summarizeHistory: sum2 } = cr2({
      chatOnce: fakeChat,
      chatViaGateway: async () => ({ ok: false }),
      cooling,
      config: { CHAT_PREFERRED: "mimo-v2.5-free", CHAT_FALLBACK: "big-pickle", CHAT_GATEWAY_TIMEOUT_MS: 25000 },
      env: { MSLXDFF_CHAT_TRACE: "0", MSLXDFF_HEDGE_DELAY_MS: "10" },
      performance,
      chatWithFallbackImpl: fakeChatWithFallback,
    });
    const r = await sum2([{ role: "user", content: "a".repeat(100) }]);
    assert.ok(String(r).startsWith("【历史摘要】"));
    const { summarizeHistory: sumFail } = cr2({
      chatOnce: fakeChat,
      chatViaGateway: async () => ({ ok: false }),
      cooling,
      config: { CHAT_PREFERRED: "mimo-v2.5-free", CHAT_FALLBACK: "big-pickle", CHAT_GATEWAY_TIMEOUT_MS: 25000 },
      env: { MSLXDFF_CHAT_TRACE: "0" },
      performance,
      chatWithFallbackImpl: async () => ({ ok: false, error: "fail" }),
    });
    const r2 = await sumFail([{ role: "user", content: "hi" }]);
    assert.equal(r2, null);
  });
});
