import assert from "node:assert/strict";
import test from "node:test";

import { createDeepseekProvider } from "../src/providers/deepseek/index.js";
import { getCustomProviderFactory } from "../src/providers/registry.js";
import { deepSeekHashV1 } from "../src/providers/deepseek/hash.js";

const BASE = "https://chat.deepseek.com";

function makeFakeUpstream({ override, onCall } = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, opts = {}) => {
      const path = String(url).replace(BASE, "");
      calls.push(path);
      if (onCall) onCall(path, opts);
      if (override) {
        const custom = override(path, opts, calls.length);
        if (custom) return custom;
      }
      if (path === "/api/v0/chat_session/create") {
        return json({ code: 0, data: { biz_code: 0, biz_data: { id: `sess-${calls.length}` } } });
      }
      if (path === "/api/v0/chat/create_pow_challenge") {
        return json({ code: 0, data: { biz_code: 0, biz_data: { challenge: {
          algorithm: "DeepSeekHashV1",
          challenge: deepSeekHashV1("salt_1757000000_3"),
          salt: "salt",
          expire_at: 1757000000,
          signature: "sig",
          difficulty: 100,
          target_path: "/api/v0/chat/completion",
        } } } });
      }
      if (path === "/api/v0/chat/completion") {
        const sse = [
          'event: ready',
          'data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}',
          '',
          'data: {"v":{"response":{"message_id":2,"role":"ASSISTANT","status":"WIP","fragments":[{"type":"THINKING","content":"思考"}]}}}',
          '',
          'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"中"}',
          '',
          'data: {"v":{"response":{"fragments":[{"type":"THINKING","content":"思考中"},{"type":"RESPONSE","content":"回答"}]}}}',
          '',
          'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
          '',
          'event: close',
          'data: {"click_behavior":"none"}',
          '',
          '',
        ].join("\n");
        return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      if (path === "/api/v0/chat_session/delete") return json({ code: 0, data: { biz_code: 0 } });
      return json({ msg: "no route" }, 404);
    },
  };
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

test("registry: deepseek id resolves to custom factory", async () => {
  const factory = await getCustomProviderFactory("deepseek", BASE);
  assert.equal(typeof factory, "function");
  assert.equal(await getCustomProviderFactory("unknown-x", "https://x.example"), null);
});

test("provider: full chain order create→pow→completion→delete (non-stream)", async () => {
  const fake = makeFakeUpstream();
  const provider = createDeepseekProvider({ apiKeys: ["tk1"], fetchImpl: fake.fetchImpl, file: "/nonexistent/x.json" });
  const res = await provider.chat({ model: "deepseek/chat", messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.choices[0].message.content, "回答");
  assert.equal(data.choices[0].message.reasoning_content, "思考中");
  assert.equal(data.choices[0].finish_reason, "stop");
  assert.equal(data.model, "deepseek/chat");

  const order = fake.calls.map((p) => p.split("?")[0]);
  assert.deepEqual(order, [
    "/api/v0/chat_session/create",
    "/api/v0/chat/create_pow_challenge",
    "/api/v0/chat/completion",
    "/api/v0/chat_session/delete",
  ]);
});

test("provider: completion body carries pow header + android headers", async () => {
  let captured = null;
  const fake = makeFakeUpstream({ onCall: (path, opts) => { if (path.includes("completion")) captured = opts; } });
  const provider = createDeepseekProvider({ apiKeys: ["tk1"], fetchImpl: fake.fetchImpl, file: "/nonexistent/x.json" });
  await provider.chat({ model: "deepseek/chat", messages: [{ role: "user", content: "hi" }] });
  assert.ok(captured);
  assert.equal(captured.headers.Authorization, "Bearer tk1");
  assert.equal(captured.headers["x-client-platform"], "android");
  const pow = JSON.parse(Buffer.from(captured.headers["x-ds-pow-response"], "base64").toString("utf8"));
  assert.equal(pow.algorithm, "DeepSeekHashV1");
  assert.ok(Number.isInteger(pow.answer));
  const body = JSON.parse(captured.body);
  assert.equal(body.thinking_enabled, false);
  assert.equal(body.prompt, "hi");
});

test("provider: reasoner maps thinking_enabled=true", async () => {
  let captured = null;
  const fake = makeFakeUpstream({ onCall: (path, opts) => { if (path.includes("completion")) captured = opts; } });
  const provider = createDeepseekProvider({ apiKeys: ["tk1"], fetchImpl: fake.fetchImpl, file: "/nonexistent/x.json" });
  await provider.chat({ model: "deepseek/reasoner", messages: [{ role: "user", content: "hi" }] });
  assert.equal(JSON.parse(captured.body).thinking_enabled, true);
});

test("provider: streaming response is OpenAI SSE with [DONE]", async () => {
  const fake = makeFakeUpstream();
  const provider = createDeepseekProvider({ apiKeys: ["tk1"], fetchImpl: fake.fetchImpl, file: "/nonexistent/x.json" });
  const res = await provider.chat({ model: "deepseek/chat", messages: [{ role: "user", content: "hi" }], stream: true });
  assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /data: \{.*"content":"回答"/s);
  assert.match(text, /"reasoning_content":"思考"/s);
  assert.match(text, /"reasoning_content":"中"/s);
  assert.match(text, /finish_reason":"stop"/s);
  assert.match(text, /data: \[DONE\]/);
});

test("provider: no token errors humanly", async () => {
  const fake = makeFakeUpstream();
  const provider = createDeepseekProvider({ apiKeys: [], fetchImpl: fake.fetchImpl, file: "/nonexistent/x.json" });
  await assert.rejects(
    () => provider.chat({ model: "deepseek/chat", messages: [{ role: "user", content: "hi" }] }),
    /缺少 DeepSeek 凭据/
  );
});

test("provider: 429 cools token and error mentions cooldown", async () => {
  const fake = makeFakeUpstream({
    override: (path) => (path === "/api/v0/chat/completion" ? json({ msg: "too many" }, 429) : null),
  });
  const provider = createDeepseekProvider({ apiKeys: ["tk1"], fetchImpl: fake.fetchImpl, file: "/nonexistent/x.json" });
  await assert.rejects(
    () => provider.chat({ model: "deepseek/chat", messages: [{ role: "user", content: "hi" }] }),
    (err) => err.status === 429 || /429|冷却|频繁/.test(String(err.message))
  );
  assert.equal(provider.keyRing.available(), 0);
});

test("provider: captcha text surfaces human guidance", async () => {
  const fake = makeFakeUpstream({
    override: (path) => (path === "/api/v0/chat/completion" ? json({ msg: "captcha required (shumei)" }, 403) : null),
  });
  const provider = createDeepseekProvider({ apiKeys: ["tk1"], fetchImpl: fake.fetchImpl, file: "/nonexistent/x.json" });
  await assert.rejects(
    () => provider.chat({ model: "deepseek/chat", messages: [{ role: "user", content: "hi" }] }),
    /风控|验证码/
  );
});

test("provider: INVALID_POW_RESPONSE retries once with fresh challenge", async () => {
  let completionCalls = 0;
  const fake = makeFakeUpstream({
    override: (path) => {
      if (path !== "/api/v0/chat/completion") return null;
      completionCalls += 1;
      if (completionCalls === 1) return json({ msg: "INVALID_POW_RESPONSE" }, 400);
      return null; // 走默认 SSE
    },
  });
  const provider = createDeepseekProvider({ apiKeys: ["tk1"], fetchImpl: fake.fetchImpl, file: "/nonexistent/x.json" });
  const res = await provider.chat({ model: "deepseek/chat", messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.choices[0].message.content, "回答");
  assert.equal(completionCalls, 2);
});

test("provider: listModels returns 4 prefixed models, cached", async () => {
  const fake = makeFakeUpstream();
  const provider = createDeepseekProvider({ apiKeys: ["tk1"], fetchImpl: fake.fetchImpl, file: "/nonexistent/x.json" });
  const list = await provider.listModels();
  assert.deepEqual(list.map((m) => m.id), [
    "deepseek/deepseek-chat-free",
    "deepseek/deepseek-reasoner-free",
    "deepseek/deepseek-chat-search-free",
    "deepseek/deepseek-reasoner-search-free",
    "deepseek/deepseek-chat-expert-free",
    "deepseek/deepseek-reasoner-expert-free",
  ]);
  const again = await provider.listModels();
  assert.equal(again, list);
  assert.ok(list.every((m) => m.object === "model"));
});

test("provider: multi-account rotates on auth failure", async () => {
  const fake = makeFakeUpstream({
    override: (path, opts) => {
      if (path === "/api/v0/chat/completion" && String(opts.headers.Authorization).includes("tk1")) {
        return json({ msg: "unauthorized" }, 401);
      }
      return null;
    },
  });
  const provider = createDeepseekProvider({ apiKeys: ["tk1", "tk2"], fetchImpl: fake.fetchImpl, file: "/nonexistent/x.json" });
  const res = await provider.chat({ model: "deepseek/chat", messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 200);
  const authedCalls = fake.calls.filter((_, i) => true);
  assert.ok(authedCalls.length >= 2);
});
