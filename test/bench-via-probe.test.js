import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { viaProbe } from "../src/bench/via-probe.js";

function mockOk(json, status = 200) {
  return { ok: true, status, text: async () => JSON.stringify(json), json: async () => json, headers: { get: () => "application/json" } };
}
function mockFail(status, txt) {
  return { ok: false, status, text: async () => txt, headers: { get: () => "" } };
}

describe("bench/via-probe", () => {
  it("最小消耗 body 约束", async () => {
    let body = null;
    const fetchImpl = async (url, init) => {
      body = JSON.parse(init.body);
      return mockOk({ choices: [{ message: { content: "hi there" } }], usage: { prompt_tokens: 1, completion_tokens: 2 } });
    };
    const r = await viaProbe({ peerUrl: "http://127.0.0.1:8989", token: "tok", providerId: "workbuddy", model: "workbuddy/hy3", fetchImpl, clock: () => 1000 });
    assert.equal(body.max_tokens, 5);
    assert.equal(body.messages[0].content, "hi");
    assert.equal(body.stream, false);
    assert.equal(body.model, "hy3");
    assert.equal(r.ok, true);
  });

  it("剥前缀 workbuddy/hy3 -> hy3", async () => {
    let body = null;
    const fetchImpl = async (u, init) => { body = JSON.parse(init.body); return mockOk({ choices: [{ message: { content: "x" } }] }); };
    await viaProbe({ peerUrl: "http://1.1.1.1:8989", token: "t", providerId: "workbuddy", model: "workbuddy/hy3", fetchImpl });
    assert.equal(body.model, "hy3");
  });

  it("不剥非前缀模型", async () => {
    let body = null;
    const fetchImpl = async (u, init) => { body = JSON.parse(init.body); return mockOk({ choices: [{ message: { content: "x" } }] }); };
    await viaProbe({ peerUrl: "http://1.1.1.1:8989", token: "t", providerId: "openrouter", model: "google/gemma-3-27b:free", fetchImpl });
    assert.equal(body.model, "google/gemma-3-27b:free");
  });

  it("429 识别为限流", async () => {
    const fetchImpl = async () => mockFail(429, "rate limit");
    const r = await viaProbe({ peerUrl: "http://1.1.1.1:8989", token: "t", model: "m", fetchImpl });
    assert.equal(r.ok, false);
    assert.equal(r.label, "限流");
    assert.equal(r.status, 429);
  });

  it("超时被捕获为 超时", async () => {
    const fetchImpl = async () => { throw new Error("timeout 30000ms"); };
    const r = await viaProbe({ peerUrl: "http://1.1.1.1:8989", token: "t", model: "m", fetchImpl });
    assert.equal(r.ok, false);
    assert.equal(r.label, "超时");
  });

  it("缺 peerUrl 直接失败不发请求", async () => {
    let called = 0;
    const fetchImpl = async () => { called++; return mockOk({}); };
    const r = await viaProbe({ peerUrl: "", token: "t", model: "m", fetchImpl });
    assert.equal(r.ok, false);
    assert.match(r.label, /配置/);
    assert.equal(called, 0);
  });
});
