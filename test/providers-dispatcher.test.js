import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createProviderDispatcher } from "../src/providers/dispatcher.js";

function stub(handler) {
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}
function urlOf(srv) { return `http://127.0.0.1:${srv.address().port}`; }
async function closeSrv(srv) { await new Promise((r) => srv.close(r)); srv.closeAllConnections?.(); }

function fakeProvider(id, seen, upstreamServer, models) {
  return {
    id,
    chat: async (body) => {
      seen.push({ id, model: body.model });
      const res = await fetch(`${upstreamServer}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return res;
    },
    listModels: async () => models,
    close: async () => {},
  };
}

test("dispatcher routes prefixed model to the matching provider and strips prefix", async () => {
  const up = await stub((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const seen = [];
  const d = createProviderDispatcher([
    fakeProvider("opencode", seen, urlOf(up), [{ id: "a-free" }]),
    fakeProvider("openrouter", seen, urlOf(up), [{ id: "openrouter/google/gemma:free" }]),
  ]);
  try {
    const res = await d.chat({ model: "openrouter/google/gemma:free", messages: [] });
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].id, "openrouter");
    assert.equal(seen[0].model, "google/gemma:free", "prefix stripped before forwarding");
  } finally {
    await d.close();
    await closeSrv(up);
  }
});

test("dispatcher routes bare model to default provider unchanged", async () => {
  const up = await stub((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const seen = [];
  const d = createProviderDispatcher([
    fakeProvider("opencode", seen, urlOf(up), [{ id: "a-free" }]),
    fakeProvider("openrouter", seen, urlOf(up), []),
  ]);
  try {
    await d.chat({ model: "deepseek-v4-flash-free", messages: [] });
    assert.equal(seen[0].id, "opencode");
    assert.equal(seen[0].model, "deepseek-v4-flash-free");
  } finally {
    await d.close();
    await closeSrv(up);
  }
});

test("dispatcher aggregates listModels across providers", async () => {
  const d = createProviderDispatcher([
    { id: "opencode", listModels: async () => [{ id: "a-free" }, { id: "b-free" }], close: async () => {} },
    { id: "openrouter", listModels: async () => [{ id: "openrouter/google/x:free" }, { id: "openrouter/nvidia/y:free" }], close: async () => {} },
  ]);
  const list = await d.listModels();
  assert.deepEqual(list.map((m) => m.id), ["a-free", "b-free", "openrouter/google/x:free", "openrouter/nvidia/y:free"]);
  await d.close();
});

test("dispatcher skips a failing provider list without breaking others", async () => {
  const d = createProviderDispatcher([
    { id: "opencode", listModels: async () => [{ id: "a-free" }], close: async () => {} },
    { id: "openrouter", listModels: async () => { throw new Error("boom"); }, close: async () => {} },
  ]);
  const list = await d.listModels();
  assert.deepEqual(list.map((m) => m.id), ["a-free"]);
  await d.close();
});

test("dispatcher falls back to default provider for unknown prefixed model, forwarding raw id", async () => {
  const up = await stub((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const seen = [];
  const d = createProviderDispatcher([
    fakeProvider("opencode", seen, urlOf(up), [{ id: "a-free" }]),
  ]);
  try {
    // "openrouter/..." 无对应 provider → 回退默认 opencode，整体当作裸 id 转发
    const res = await d.chat({ model: "openrouter/google/x:free", messages: [] });
    assert.equal(res.status, 200);
    assert.equal(seen[0].id, "opencode");
    assert.equal(seen[0].model, "openrouter/google/x:free");
  } finally {
    await d.close();
    await closeSrv(up);
  }
});