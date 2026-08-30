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
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { saveProviderAllowedModels } = await import("../src/state.js");
  function tmpStateFile() { const d=mkdtempSync(join(tmpdir(),"mslxdff-disp-")); return join(d,"state.json"); }
  const file = tmpStateFile();
  const prev = process.env.MSLXDFF_STATE_FILE;
  process.env.MSLXDFF_STATE_FILE = file;
  saveProviderAllowedModels("openrouter", ["google/gemma:free"], { file });
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
    if (prev) process.env.MSLXDFF_STATE_FILE = prev; else delete process.env.MSLXDFF_STATE_FILE;
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
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { saveProviderAllowedModels } = await import("../src/state.js");
  function tmpStateFile() { const d=mkdtempSync(join(tmpdir(),"mslxdff-disp-")); return join(d,"state.json"); }
  const file = tmpStateFile();
  const prev = process.env.MSLXDFF_STATE_FILE;
  process.env.MSLXDFF_STATE_FILE = file;
  saveProviderAllowedModels("openrouter", ["google/x:free", "nvidia/y:free"], { file });
  const d = createProviderDispatcher([
    { id: "opencode", listModels: async () => [{ id: "a-free" }, { id: "b-free" }], close: async () => {} },
    { id: "openrouter", listModels: async () => [{ id: "openrouter/google/x:free" }, { id: "openrouter/nvidia/y:free" }], close: async () => {} },
  ]);
  const list = await d.listModels();
  assert.deepEqual(list.map((m) => m.id), ["a-free", "b-free", "openrouter/google/x:free", "openrouter/nvidia/y:free"]);
  await d.close();
  if (prev) process.env.MSLXDFF_STATE_FILE = prev; else delete process.env.MSLXDFF_STATE_FILE;
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
test("dispatcher uses chatWithKeys when shareKeys hit the provider (no local key needed)", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { saveProviderAllowedModels } = await import("../src/state.js");
  function tmpStateFile() { const d=mkdtempSync(join(tmpdir(),"mslxdff-disp-")); return join(d,"state.json"); }
  const file = tmpStateFile();
  const prev = process.env.MSLXDFF_STATE_FILE;
  process.env.MSLXDFF_STATE_FILE = file;
  saveProviderAllowedModels("openrouter", ["google/gemma:free"], { file });
  let usedKeys = null;
  const d = createProviderDispatcher([
    { id: "opencode", chat: async (b) => ({ status: 500, body: null, _t: {} }), listModels: async () => [], close: async () => {} },
    {
      id: "openrouter",
      chat: async (b) => ({ status: 500, body: null, _t: {} }),
      chatWithKeys: async (b, keys) => { usedKeys = keys; return { status: 200, body: null, _t: {} }; },
      listModels: async () => [],
      close: async () => {},
    },
  ]);
  try {
    const res = await d.chat({ model: "openrouter/google/gemma:free", messages: [] }, { shareKeys: { openrouter: ["sk-shared-1", "sk-shared-2"] } });
    assert.equal(res.status, 200);
    assert.deepEqual(usedKeys, ["sk-shared-1", "sk-shared-2"]);
  } finally { await d.close(); if (prev) process.env.MSLXDFF_STATE_FILE = prev; else delete process.env.MSLXDFF_STATE_FILE; }
});

test("dispatcher ignores shareKeys for providers that opt out (chatWithKeys absent)", async () => {
  const d = createProviderDispatcher([
    { id: "opencode", chat: async (b) => ({ status: 200, body: null, _t: {} }), listModels: async () => [], close: async () => {} },
  ]);
  try {
    // bare model + shareKeys 传入但 opencode 无 chatWithKeys → 走普通 chat
    const res = await d.chat({ model: "big-pickle", messages: [] }, { shareKeys: { opencode: ["sk-x"] } });
    assert.equal(res.status, 200);
  } finally { await d.close(); }
});
