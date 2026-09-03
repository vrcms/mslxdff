import { test } from "node:test";
import assert from "node:assert/strict";
import { createClineProvider } from "../src/providers/cline/index.js";

const DUMMY_RT = "eyJhbGciOiJIUzI1NiJ9.fake_refresh_token_long_12345678901234567890";

function captureChat() {
  const seen = [];
  async function fetchImpl(url, opts) {
    const u = String(url);
    if (u.includes("/auth/refresh")) {
      return new Response(JSON.stringify({
        data: { accessToken: "fake_at_abc", refreshToken: DUMMY_RT, expiresAt: Date.now() + 600000 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/chat/completions")) {
      seen.push(JSON.parse(opts.body || "{}"));
      const sse = `data: ${JSON.stringify({ id: "r1", choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  }
  return { fetchImpl, seen };
}

test("cline: provider-prefixed deepseek id is stripped before upstream", async () => {
  const { fetchImpl, seen } = captureChat();
  const p = createClineProvider({ id: "clinebot", apiKeys: [DUMMY_RT], fetchImpl });
  const resp = await p.chat({ model: "clinebot/deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "hi" }], stream: false });
  assert.equal(resp.status, 200);
  assert.equal(seen[0].model, "deepseek/deepseek-v4-flash", "upstream must receive bare id");
});

test("cline: stripped deepseek id triggers forceStream aggregation", async () => {
  const { fetchImpl, seen } = captureChat();
  const p = createClineProvider({ id: "clinebot", apiKeys: [DUMMY_RT], fetchImpl });
  await p.chat({ model: "clinebot/deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "hi" }], stream: false });
  assert.equal(seen[0].stream, true, "deepseek must be forced to stream=true upstream");
});

test("cline: z-ai prefixed id is stripped, stream not forced", async () => {
  const { fetchImpl, seen } = captureChat();
  const p = createClineProvider({ id: "clinebot", apiKeys: [DUMMY_RT], fetchImpl });
  await p.chat({ model: "clinebot/z-ai/glm-5.3-flash", messages: [{ role: "user", content: "hi" }], stream: false });
  assert.equal(seen[0].model, "z-ai/glm-5.3-flash", "upstream must receive bare id");
  assert.ok(!seen[0].stream, "non-deepseek must not force stream");
});

test("cline: bare id passes through untouched", async () => {
  const { fetchImpl, seen } = captureChat();
  const p = createClineProvider({ id: "clinebot", apiKeys: [DUMMY_RT], fetchImpl });
  await p.chat({ model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "hi" }], stream: false });
  assert.equal(seen[0].model, "deepseek/deepseek-v4-flash");
  assert.equal(seen[0].stream, true);
});
