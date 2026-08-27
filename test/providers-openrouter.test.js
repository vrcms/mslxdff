import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createOpenRouterProvider } from "../src/providers/openrouter.js";

function stub(handler) {
  const srv = createServer(handler);
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}
function urlOf(srv) { return `http://127.0.0.1:${srv.address().port}`; }
async function closeSrv(srv) { await new Promise((r) => srv.close(r)); srv.closeAllConnections?.(); }

test("openrouter listModels keeps only zero-priced models and prefixes id", async () => {
  const srv = await stub((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: [
        { id: "free/a", pricing: { prompt: 0, completion: 0 } },
        { id: "paid/b", pricing: { prompt: 0.5, completion: 0.5 } },
        { id: "free/c", pricing: { prompt: 0, completion: 0 } },
        { id: "var/d", pricing: { prompt: 0, completion: 1 } },
        { id: "free/e", pricing: {} },
        { id: "str/f", pricing: { prompt: "0", completion: "0" } },
      ],
    }));
  });
  try {
    const p = createOpenRouterProvider({ baseUrl: urlOf(srv), connectTimeoutMs: 2000 });
    const list = await p.listModels();
    const ids = list.map((m) => m.id);
    // 字符串 "0" 也按 0 价格纳入（Number("0")===0）
    assert.deepEqual(ids, ["openrouter/free/a", "openrouter/free/c", "openrouter/free/e", "openrouter/str/f"]);
    assert.ok(ids.every((x) => x.startsWith("openrouter/")));
    await p.close();
  } finally {
    await closeSrv(srv);
  }
});

test("openrouter listModels caches for TTL and returns [] on upstream failure", async () => {
  let calls = 0;
  const srv = await stub((req, res) => {
    calls++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "free/a", pricing: { prompt: 0, completion: 0 } }] }));
  });
  try {
    const p = createOpenRouterProvider({ baseUrl: urlOf(srv), connectTimeoutMs: 2000 });
    await p.listModels();
    await p.listModels();
    assert.equal(calls, 1, "cached");
    await p.close();
  } finally {
    await closeSrv(srv);
  }

  const bad = await stub((req, res) => {
    res.writeHead(500);
    res.end("boom");
  });
  try {
    const p2 = createOpenRouterProvider({ baseUrl: urlOf(bad), connectTimeoutMs: 1000 });
    const list = await p2.listModels();
    assert.deepEqual(list, []);
    await p2.close();
  } finally {
    await closeSrv(bad);
  }
});

test("openrouter chat requires key (no key => clear error)", async () => {
  const srv = await stub((req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "No cookie auth credentials found", code: 401 } }));
  });
  try {
    const p = createOpenRouterProvider({ apiKey: "", baseUrl: urlOf(srv), connectTimeoutMs: 1000 });
    await assert.rejects(() => p.chat({ model: "google/gemma:free", messages: [] }), /MSLXDFF_OPENROUTER_KEY/);
    await p.close();
  } finally {
    await closeSrv(srv);
  }
});

test("openrouter chat sends Bearer key + brand headers and returns upstream", async () => {
  let seen = null;
  const srv = await stub((req, res) => {
    seen = req.headers;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, model: "google/gemma:free" }));
  });
  let p;
  try {
    p = createOpenRouterProvider({ apiKey: "sk-test", baseUrl: urlOf(srv), connectTimeoutMs: 2000 });
    const res = await p.chat({ model: "google/gemma:free", messages: [{ role: "user", content: "hi" }], stream: false });
    assert.equal(res.status, 200);
    assert.equal(seen["authorization"], "Bearer sk-test");
    assert.ok(seen["http-referer"], "brand referer header present");
    assert.ok(seen["x-title"], "brand title header present");
    assert.equal(seen["content-type"], "application/json");
  } finally {
    await p?.close();
    await closeSrv(srv);
  }
});

test("openrouter chat retries a 5xx once then succeeds", async () => {
  let calls = 0;
  const srv = await stub((req, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  let p;
  try {
    p = createOpenRouterProvider({ apiKey: "sk", baseUrl: urlOf(srv), retry: { 502: { attempts: 1, delayMs: 5 } }, connectTimeoutMs: 2000 });
    const res = await p.chat({ model: "x:free", messages: [] });
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
  } finally {
    await p?.close();
    await closeSrv(srv);
  }
});