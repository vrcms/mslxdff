import { test } from "node:test";
import assert from "node:assert/strict";
import { createClineProvider } from "../src/providers/cline/index.js";

const DUMMY_RT = "eyJhbGciOiJIUzI1NiJ9.fake_refresh_token_long_12345678901234567890";

function mockFetch({ refreshOk = true, chatSse = true } = {}) {
  const calls = { refresh: 0, chat: 0, models: 0 };
  async function fetchImpl(url, opts) {
    const u = String(url);
    if (u.includes("/auth/refresh")) {
      calls.refresh++;
      if (!refreshOk) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      return new Response(JSON.stringify({
        data: { accessToken: "fake_at_abc", refreshToken: DUMMY_RT, expiresAt: Date.now() + 10 * 60 * 1000 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/chat/completions")) {
      calls.chat++;
      const h = opts.headers || {};
      assert.ok(String(h["User-Agent"]).includes("Cline/"), "must carry Cline UA");
      assert.ok(String(h.Authorization).startsWith("Bearer workos:"), "must carry workos token");
      assert.equal(h["X-CLIENT-TYPE"], "cline-sdk");
      const body = JSON.parse(opts.body || "{}");
      if (chatSse) {
        const sse = `data: ${JSON.stringify({ id: "r1", choices: [{ delta: { content: "你好" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
        return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ data: body }), { status: 200 });
    }
    if (u.includes("/recommended-models")) {
      calls.models++;
      return new Response(JSON.stringify({ free: [{ id: "deepseek/deepseek-v4-flash" }, { id: "poolside/laguna-s-2.1:free" }] }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }
  return { fetchImpl, calls };
}

test("cline: refresh token detected, legacy sk_ key not", () => {
  const p1 = createClineProvider({ id: "clinebot", apiKeys: [DUMMY_RT], fetchImpl: async () => new Response("", { status: 404 }) });
  assert.ok(p1._authPool, "refresh token must enable auth pool");
  assert.equal(p1._authPool.getAccounts().length, 1);
  const p2 = createClineProvider({ id: "clinebot", apiKeys: ["sk_test123"], fetchImpl: async () => new Response("", { status: 404 }) });
  assert.equal(p2._authPool, null, "sk_ key must stay legacy direct mode");
});

test("cline: chat exchanges refresh for workos token and sends fingerprint headers", async () => {
  const { fetchImpl, calls } = mockFetch();
  const p = createClineProvider({ id: "clinebot", apiKeys: [DUMMY_RT], fetchImpl });
  const resp = await p.chat({ model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "hi" }], stream: true });
  assert.equal(resp.status, 200);
  assert.equal(calls.refresh, 1);
  assert.equal(calls.chat, 1);
  const txt = await resp.text();
  assert.ok(txt.includes("你好"), "stream body must contain content");
});

test("cline: non-stream deepseek forces upstream stream and aggregates", async () => {
  const seen = [];
  const { fetchImpl } = mockFetch();
  const orig = fetchImpl;
  const wrapped = async (url, opts) => {
    if (String(url).includes("/chat/completions")) {
      seen.push(JSON.parse(opts.body || "{}"));
    }
    return orig(url, opts);
  };
  const p = createClineProvider({ id: "clinebot", apiKeys: [DUMMY_RT], fetchImpl: wrapped });
  const resp = await p.chat({ model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "hi" }], stream: false });
  assert.equal(resp.status, 200);
  assert.equal(seen[0].stream, true, "deepseek must be forced to stream=true");
  const j = JSON.parse(await resp.text());
  assert.equal(j.choices[0].message.content, "你好");
});

test("cline: listModels only returns free array with provider prefix", async () => {
  const { fetchImpl, calls } = mockFetch();
  const p = createClineProvider({ id: "clinebot", apiKeys: [DUMMY_RT], fetchImpl });
  const models = await p.listModels();
  assert.equal(calls.models, 1);
  assert.deepEqual(models.map((m) => m.id), ["clinebot/deepseek/deepseek-v4-flash", "clinebot/poolside/laguna-s-2.1:free"]);
});

test("cline: refresh failure cools account and retry hits next", async () => {
  let n = 0;
  async function fetchImpl(url, opts) {
    if (String(url).includes("/auth/refresh")) {
      n++;
      if (n <= 1) return new Response(JSON.stringify({ error: "server_error" }), { status: 500 });
      return new Response(JSON.stringify({ data: { accessToken: "at2", refreshToken: DUMMY_RT, expiresAt: Date.now() + 600000 } }), { status: 200 });
    }
    if (String(url).includes("/chat/completions")) {
      return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response("", { status: 404 });
  }
  const p = createClineProvider({ id: "clinebot", apiKeys: [DUMMY_RT], fetchImpl });
  const resp = await p.chat({ model: "poolside/laguna-s-2.1:free", messages: [{ role: "user", content: "hi" }], stream: true });
  assert.equal(resp.status, 200);
  assert.ok(n >= 2, "must retry refresh after first failure");
});