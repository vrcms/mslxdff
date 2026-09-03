import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createChatGateway } from "../src/routes/chat/gateway.js";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";

function withGateway({ upstream, auto, headers, model, stream = false }) {
  const gw = createChatGateway({ upstream, auto, logs: null, peers: null, maxHops: 3, groups: null, bus: new EventEmitter(), token: "tok", plugins: [] });
  const reqHeaders = { "content-type": "application/json", ...(headers || {}) };
  const bodyObj = { model, messages: [{ role: "user", content: "hi" }], stream };
  const server = createServer(async (req, res) => {
    for (const [k, v] of Object.entries(reqHeaders)) req.headers[k.toLowerCase()] = v;
    req.headers["content-type"] = "application/json";
    await gw.handle({ req, res });
  });
  return new Promise((resolve) => {
    server.listen(0, async () => {
      const port = server.address().port;
      const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: reqHeaders,
        body: JSON.stringify(bodyObj),
      });
      const text = await resp.text();
      const resHeaders = Object.fromEntries(resp.headers.entries());
      server.close();
      resolve({ status: resp.status, text, headers: resHeaders, body: (() => { try { return JSON.parse(text); } catch { return text; } })() });
    });
  });
}

function fakeAuto({ candidates = [], statuses = {} } = {}) {
  return {
    candidates: async () => candidates,
    candidatesFor: async (m) => (m ? [m] : candidates),
    isCooling: () => false,
    statuses: () => ({ ...statuses }),
    recordOk: async () => {},
    recordError: async () => {},
    recordLatency: async () => {},
  };
}

describe("chat-pipeline 薄适配层", () => {
  it("500 前透传：direct 单模型 503 上游不回退直传", async () => {
    const upRes500 = new Response(JSON.stringify({ error: "upstream down" }), { status: 500, headers: { "content-type": "application/json" } });
    const upstream = { chat: async () => upRes500 };
    const body = withGateway({ upstream, auto: fakeAuto(), model: "locked", headers: { "x-mslxdff-model-lock": "locked" } });
    const r = await body;
    assert.ok([500, 502].includes(r.status), `expected 500/502 got ${r.status} ${r.text}`);
  });
  it("allowlist 403 在 auto 下软跳，下一候选成功", async () => {
    const order = ["blocked", "good"];
    let calls = 0;
    const upstream = {
      chat: async (payload) => {
        calls++;
        if (payload.model === "blocked") {
          const h = new Map([["x-mslxdff-allowlist", "1"]]);
          h.get = h.get.bind(h);
          return { status: 403, headers: h, clone: () => ({ text: async () => "{}" }), text: async () => "{}" };
        }
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    };
    const r = await withGateway({ upstream, auto: fakeAuto({ candidates: order }), model: "" });
    assert.ok(calls >= 2, `expected blocked+good both tried, got ${calls}`);
    assert.ok([200, 403].includes(r.status), `expected 200 after skip got ${r.status} ${r.text}`);
  });
  it("mslxdff/ 别名剥前缀且 x-mslxdff-alias 头回显", async () => {
    let calledModel = null;
    const upstream = {
      chat: async (payload) => {
        calledModel = payload.model;
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" } }] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    };
    const r = await withGateway({ upstream, auto: fakeAuto(), model: "mslxdff/bai-deepseek-v4-flash" });
    assert.ok(r.status === 200, `got ${r.status}`);
    assert.ok(calledModel && calledModel.includes("deepseek"), `model stripped from mslxdff/: ${calledModel}`);
  });
  it("plugins 存在时 request:received 可 respond 短路", async () => {
    const respondPlugin = { name: "shortcircuit", hooks: { "request:received": async () => ({ respond: { status: 201, body: { hello: "plugin" } } }) } };
    const gw = createChatGateway({ upstream: { chat: async () => new Response("{}", { status: 200 }) }, auto: fakeAuto(), logs: null, maxHops: 3, plugins: [respondPlugin] });
    const server = createServer(async (req, res) => {
      req.headers["content-type"] = "application/json";
      await gw.handle({ req, res });
    });
    const resp = await new Promise((resolve) => {
      server.listen(0, async () => {
        const port = server.address().port;
        const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "auto", messages: [] }) });
        server.close();
        resolve(r);
      });
    });
    assert.equal(resp.status, 201);
    assert.deepEqual(await resp.json(), { hello: "plugin" });
  });
});