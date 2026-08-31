import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runOne } from "../src/bench/runner.js";

function mockOk(json, status = 200) {
  return { ok: true, status, text: async () => JSON.stringify(json), json: async () => json, headers: { get: () => "application/json" } };
}
function mockFail(status, txt) {
  return { ok: false, status, text: async () => txt, headers: { get: () => "" } };
}

describe("bench/runner", () => {
  it("成功计算 tps/chars", async () => {
    const fetchImpl = async () => mockOk({ choices: [{ message: { content: "hello world" } }], usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 } });
    const r = await runOne({ baseUrl: "https://api.example.com", chatPath: "/v1/chat/completions", model: "workbuddy/hy3", apiKey: "sk-1", fetchImpl, clock: () => 1000 });
    assert.equal(r.ok, true);
    assert.equal(r.tokens.completion, 10);
    assert.ok(r.totalMs >= 0);
    // tps 可能为 null 若 total==ttfb，但 chars 应有
  });

  it("无 apiKey 直接失败不发请求", async () => {
    let called = 0;
    const fetchImpl = async () => { called++; return mockOk({}); };
    const r = await runOne({ baseUrl: "https://api.example.com", model: "m", apiKey: "", fetchImpl });
    assert.equal(r.ok, false);
    assert.match(r.label, /Key/);
    assert.equal(called, 0);
  });

  it("402 识别为余额不足", async () => {
    const fetchImpl = async () => mockFail(402, JSON.stringify({ error: "insufficient balance" }));
    const r = await runOne({ baseUrl: "https://a.com", model: "hy3", apiKey: "k", fetchImpl });
    assert.equal(r.ok, false);
    assert.equal(r.label, "余额不足");
    assert.equal(r.status, 402);
  });

  it("429 识别为限流", async () => {
    const fetchImpl = async () => mockFail(429, "rate limit");
    const r = await runOne({ baseUrl: "https://a.com", model: "m", apiKey: "k", fetchImpl });
    assert.equal(r.label, "限流");
  });

  it("超时被捕获", async () => {
    const fetchImpl = async () => { throw new Error("timeout 15000ms"); };
    const r = await runOne({ baseUrl: "https://a.com", model: "m", apiKey: "k", fetchImpl });
    assert.equal(r.ok, false);
    assert.equal(r.label, "超时");
  });
});
