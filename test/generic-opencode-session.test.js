import { test } from "node:test";
import assert from "node:assert/strict";
import { createGenericProvider } from "../src/providers/generic.js";

// ocgo（opencode.ai/zen/go）：Console Go 要求 x-opencode-session 才能路由，
// 缺失 → 400 {"type":"MissingSessionID",...}。generic 对 opencode.ai 域名自动补身份头。
function stubChat(captured) {
  return async (url, opts) => {
    captured.headers = opts.headers;
    return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
}

test("generic ocgo：自动带 x-opencode-session/request 身份头（防 400 MissingSessionID）", async () => {
  const captured = {};
  const p = createGenericProvider({
    id: "ocgo", baseUrl: "https://opencode.ai/zen/go/v1", apiKeys: ["sk-test"],
    fetchImpl: stubChat(captured), noAgent: true,
  });
  await p.chat({ model: "mimo-v2.5", messages: [{ role: "user", content: "hi" }], stream: false });
  const h = captured.headers;
  assert.match(h["x-opencode-session"], /^ses_.{26}$/, "session 必须 opencode 形状");
  assert.match(h["x-opencode-request"], /^msg_.{26}$/, "request 必须 opencode 形状");
  assert.match(h["User-Agent"], /^opencode\//, "UA 必须 opencode/<semver>");
  assert.equal(h["x-opencode-client"], "desktop");
  assert.equal(h["x-opencode-project"], "global");
  assert.equal(h["Authorization"], "Bearer sk-test");
  await p.close();
});

test("generic ocgo：opts.sessionId 透传且稳定（同值同 session）", async () => {
  const c1 = {}, c2 = {}, c3 = {};
  const mk = (c) => createGenericProvider({
    id: "ocgo", baseUrl: "https://opencode.ai/zen/go/v1", apiKeys: ["sk-test"],
    fetchImpl: stubChat(c), noAgent: true,
  });
  const body = { model: "mimo-v2.5", messages: [{ role: "user", content: "hi" }], stream: false };
  const p1 = mk(c1); await p1.chat(body, { sessionId: "affinity-1" }); await p1.close();
  const p2 = mk(c2); await p2.chat(body, { sessionId: "affinity-1" }); await p2.close();
  const p3 = mk(c3); await p3.chat(body, { sessionId: "affinity-2" }); await p3.close();
  assert.match(c1.headers["x-opencode-session"], /^ses_.{26}$/);
  assert.equal(c1.headers["x-opencode-session"], c2.headers["x-opencode-session"], "同 affinity 必须同 session");
  assert.notEqual(c1.headers["x-opencode-session"], c3.headers["x-opencode-session"], "不同 affinity 必须不同 session");
});

test("generic 非 opencode 域名：不带 opencode 身份头（行为不变）", async () => {
  const captured = {};
  const p = createGenericProvider({
    id: "bai", baseUrl: "https://api.b.ai/v1", apiKeys: ["sk-test"],
    fetchImpl: stubChat(captured), noAgent: true,
  });
  await p.chat({ model: "x", messages: [], stream: false }, { sessionId: "abc" });
  assert.ok(!("x-opencode-session" in captured.headers), "非 opencode 域名不应带 session");
  assert.equal(captured.headers["User-Agent"], "mslxdff");
  await p.close();
});
