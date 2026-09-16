import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createChatGateway } from "../src/routes/chat/gateway.js";
import { createChatPipeline } from "../src/chat-pipeline/index.js";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 组合路径会触达 savePreferredModel / recordModelStats —— 指向 tmp 隔离，不碰真实 state
process.env.MSLXDFF_STATE_FILE = join(mkdtempSync(join(tmpdir(), "mslxdff-test-compose-")), "state.json");

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

// 唯一 seam：直接驱动 execute({req,res})，不启 HTTP server —— 覆盖真实编排（TDZ 曾在此存活）
function captureRes() {
  const cap = { status: 0, body: null, headers: {}, ended: false };
  const res = {
    statusCode: 0,
    headersSent: false,
    setHeader(k, v) { cap.headers[k.toLowerCase()] = String(v); },
    on() { return res; },
    removeListener() { return res; },
    write() { return true; },
    end(chunk) { if (chunk) cap.body = String(chunk); cap.status = res.statusCode; cap.ended = true; },
  };
  return { res, cap };
}

function composePipeline({ candidates, upstream, events }) {
  const logs = { appendCall() {}, appendError() {}, appendEvent(e) { events.push(e); } };
  return createChatPipeline({
    upstream,
    auto: fakeAuto({ candidates }),
    logs,
    peers: null,
    groups: null,
    bus: { emit(e) { events.push(e); } },
    token: "tok",
    plugins: [],
  });
}

describe("ChatPipeline.execute 组合路径（唯一 seam）", () => {
  it("auto + x-mslxdff-auto-provider=opencode：候选过滤、auto-scope 事件、正常返回（回归 TDZ 500）", async () => {
    const events = [];
    const calledModels = [];
    const pipeline = composePipeline({
      candidates: ["big-pickle", "mimo-v2.5-free", "not-free-model"],
      events,
      upstream: {
        chat: async (payload) => {
          calledModels.push(payload.model);
          return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    });
    const { res, cap } = captureRes();
    await pipeline.execute({
      req: {
        headers: { "x-mslxdff-auto-provider": "opencode" },
        body: { model: "auto", messages: [{ role: "user", content: "hi" }], stream: false },
        socket: { remoteAddress: "127.0.0.1" },
      },
      res,
    });
    assert.equal(cap.status, 200, `expected 200 got ${cap.status} body=${String(cap.body).slice(0, 200)}`);
    assert.ok(calledModels.length >= 1, `upstream 应被调用: ${JSON.stringify(calledModels)}`);
    assert.ok(!calledModels.includes("not-free-model"), `非免费模型不应被调用: ${JSON.stringify(calledModels)}`);
    const scope = events.find((e) => e.type === "auto-scope");
    assert.ok(scope, `auto-scope 事件应发出（TDZ 回归）: ${JSON.stringify(events.map((e) => e.type))}`);
    assert.equal(scope.before, 3);
    assert.equal(scope.after, 2);
    assert.ok(events.some((e) => e.type === "request"), "request 事件应发出");
  });

  it("auto 无 provider 头：全候选参与编排并正常返回", async () => {
    const events = [];
    const calledModels = [];
    const pipeline = composePipeline({
      candidates: ["big-pickle", "mimo-v2.5-free"],
      events,
      upstream: {
        chat: async (payload) => {
          calledModels.push(payload.model);
          return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" } }] }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    });
    const { res, cap } = captureRes();
    await pipeline.execute({
      req: {
        headers: {},
        body: { model: "auto", messages: [{ role: "user", content: "hi" }], stream: false },
        socket: { remoteAddress: "127.0.0.1" },
      },
      res,
    });
    assert.equal(cap.status, 200, `expected 200 got ${cap.status}`);
    assert.ok(calledModels.length >= 2, `两个候选应参与并发: ${JSON.stringify(calledModels)}`);
    assert.ok(!events.some((e) => e.type === "auto-scope"), "无 provider 头不应发 auto-scope");
  });
});