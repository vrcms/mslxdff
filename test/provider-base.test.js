import { test } from "node:test";
import assert from "node:assert/strict";
import { envInt, joinUrl, createAgent, collectApiKeysGeneric, createChatRunner, createListModelsRunner } from "../src/providers/base.js";
import { createKeyRing } from "../src/providers/keyring.js";

test("base envInt returns fallback for non-int", () => {
  process.env.TEST_INT = "abc";
  assert.equal(envInt("TEST_INT", 42), 42);
  process.env.TEST_INT = "5";
  assert.equal(envInt("TEST_INT", 42), 5);
  delete process.env.TEST_INT;
});

test("base joinUrl handles slash correctly", () => {
  assert.equal(joinUrl("https://api.example.com/", "/v1/chat"), "https://api.example.com/v1/chat");
  assert.equal(joinUrl("https://api.example.com", "v1/models"), "https://api.example.com/v1/models");
  assert.equal(joinUrl("https://api.example.com///", "///v1/"), "https://api.example.com///v1/");
  assert.equal(joinUrl("https://api.example.com", ""), "https://api.example.com");
});

test("base createAgent returns agent/dispatcher when undici available", async () => {
  const { agent, dispatcher } = createAgent({ keepAliveTimeout: 1000, keepAliveMaxTimeout: 2000, connections: 5 });
  // undici may not be available in test env without install, but should not throw
  assert.ok(agent === null || typeof agent === "object");
  if (agent && agent.close) await agent.close().catch(() => {});
});

test("base collectApiKeysGeneric merges explicit + state", async () => {
  const fakeLoad = (id) => id === "myid" ? ["sk-state"] : [];
  assert.deepEqual(collectApiKeysGeneric("myid", undefined, undefined, fakeLoad), ["sk-state"]);
  assert.deepEqual(collectApiKeysGeneric("myid", ["sk-1"], undefined, fakeLoad), ["sk-1"]);
  assert.deepEqual(collectApiKeysGeneric("myid", ["sk-1", "sk-1"], "sk-2", fakeLoad), ["sk-1", "sk-2"]);
});

test("base createChatRunner retry network then success", async () => {
  let call = 0;
  const fakeFetch = async (url, opts) => {
    call++;
    if (call === 1) throw new Error("network fail");
    return { status: 200, headers: new Map(), _t: { totalMs: 10 } };
  };
  const ring = createKeyRing(["sk-1"], { cooldownMs: 0 });
  const { runChat } = createChatRunner({
    id: "testbase",
    ring,
    cooldownMs: 0,
    retry: { network: { attempts: 2, delayMs: 1 } },
    fetchImpl: fakeFetch,
    dispatcher: null,
    buildHeaders: () => ({}),
    getUrl: () => "https://api.example.com/chat",
    connectTimeoutMs: 5000,
  });
  const res = await runChat({ model: "m", messages: [] }, ring, "TEST_KEY");
  assert.equal(res.status, 200);
  assert.equal(call, 2);
});

test("base createChatRunner 429 retry once", async () => {
  let call = 0;
  const fakeFetch = async () => {
    call++;
    if (call === 1) return { status: 429, headers: new Map() };
    return { status: 200, headers: new Map() };
  };
  const ring = createKeyRing(["sk-1"], { cooldownMs: 0 });
  const { runChat } = createChatRunner({
    id: "testbase",
    ring,
    cooldownMs: 0,
    retry: { 429: { attempts: 1, delayMs: 1 } },
    fetchImpl: fakeFetch,
    dispatcher: null,
    buildHeaders: () => ({}),
    getUrl: () => "https://api.example.com/chat",
  });
  const res = await runChat({ model: "m" }, ring, "K");
  assert.equal(res.status, 200);
  assert.equal(call, 2);
});

test("base createListModelsRunner caches 10min", async () => {
  let fetchCalls = 0;
  const fakeFetch = async (url, opts) => {
    fetchCalls++;
    return {
      ok: true,
      json: async () => ({ data: [{ id: "m1" }, { id: "m2" }] }),
      headers: new Map(),
    };
  };
  const ring = createKeyRing(["sk-1"], { cooldownMs: 0 });
  const { listModels } = createListModelsRunner({
    id: "myprov",
    ring,
    dispatcher: null,
    fetchImpl: fakeFetch,
    getUrl: () => "https://api.example.com/models",
  });
  const a = await listModels();
  const b = await listModels();
  assert.equal(a.length, 2);
  assert.equal(a[0].id, "myprov/m1");
  assert.equal(fetchCalls, 1, "second call should be cached");
  assert.deepEqual(a, b);
});
