import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGenericProvider } from "../src/providers/generic.js";
import { createOpenRouterProvider } from "../src/providers/openrouter.js";
import { createProviderDispatcher } from "../src/providers/dispatcher.js";
import { createKeyRing } from "../src/providers/keyring.js";

describe("generic 深模块 extraHeaders + mapModel", () => {
  test("US2 generic 注入 X-Custom 同时保留 Authorization", async () => {
    let capturedHeaders = null;
    const fakeFetch = async (url, opts) => {
      capturedHeaders = opts.headers;
      return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const ring = createKeyRing(["k1"], { cooldownMs: 30000 });
    // 直接测 buildHeaders via chat → 捕获 header
    const p = createGenericProvider({
      id: "my",
      baseUrl: "https://example.com/v1",
      apiKeys: ["k1"],
      headers: { "X-Custom": "1" },
      fetchImpl: fakeFetch,
      noAgent: true,
    });
    await p.chat({ model: "my/m", messages: [{ role: "user", content: "hi" }], stream: false });
    assert.ok(capturedHeaders["Authorization"] === "Bearer k1", `Authorization missing ${JSON.stringify(capturedHeaders)}`);
    assert.equal(capturedHeaders["X-Custom"], "1");
    await p.close();
  });

  test("US3 generic mapModel 过滤仅 free", async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify({ data: [{ id: "a", pricing: { prompt: 0, completion: 0 } }, { id: "b", pricing: { prompt: 1, completion: 0 } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const p = createGenericProvider({
      id: "my",
      baseUrl: "https://example.com/v1",
      apiKeys: ["k1"],
      fetchImpl: fakeFetch,
      noAgent: true,
    });
    const all = await p.listModels();
    assert.equal(all.length, 2);
    await p.close();
    // 注入 mapModel 的 generic 应可过滤
    const p3 = createGenericProvider({
      id: "my3",
      baseUrl: "https://example.com/v1",
      apiKeys: ["k1"],
      fetchImpl: fakeFetch,
      mapModel: (raw) => raw.filter((m) => Number(m.pricing?.prompt || 0) === 0),
      noAgent: true,
    });
    const filtered = await p3.listModels();
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, "my3/a");
    await p3.close();
  });
});

describe("openrouter 薄适配", () => {
  test("US1 openrouter 默认 Referer+free filter 薄包装", async () => {
    let capturedHeaders = null;
    const fakeFetch = async (url, opts) => {
      if (String(url).includes("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "a", pricing: { prompt: 0, completion: 0 } }, { id: "b", pricing: { prompt: 1, completion: 0 } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      capturedHeaders = opts.headers;
      return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const p = createOpenRouterProvider({ apiKeys: ["k1"], fetchImpl: fakeFetch, noAgent: true });
    // list 应仅 free
    const list = await p.listModels();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "openrouter/a");
    // chat header 含 Referer
    await p.chat({ model: "openrouter/a", messages: [] });
    assert.equal(capturedHeaders["HTTP-Referer"], "https://github.com/mslxdff");
    assert.equal(capturedHeaders["X-Title"], "mslxdff");
    await p.close();
    // 验证 openrouter.js ≤40行 且复用 generic（不含逐行复制的 base 逻辑）
    const fs = await import("node:fs");
    const txt = fs.readFileSync("src/providers/openrouter.js", "utf8");
    const lines = txt.split("\n").length;
    assert.ok(lines <= 40, `openrouter 应 ≤40行，实 ${lines}`);
    assert.ok(!txt.includes("createListModelsRunner") || txt.includes("createGenericProvider"), "openrouter 应复用 generic 而非直调 base runner");
  });
});

describe("dispatcher 纯化", () => {
  test("US4 dispatcher 注入 isAllowed 决定 403", async () => {
    let chatCalled = false;
    const p = {
      id: "p",
      chat: async (b) => { chatCalled = true; return new Response(JSON.stringify({ ok: 1 }), { status: 200 }); },
      listModels: async () => [],
      close: async () => {},
    };
    const d = createProviderDispatcher([p], {
      isAllowed: (id, raw) => raw === "ok",
      getAllowedModels: () => ["ok"],
      getAllowAny: () => false,
    });
    const resOk = await d.chat({ model: "p/ok", messages: [] });
    assert.equal(resOk.status, 200);
    assert.equal(chatCalled, true);
    chatCalled = false;
    const resBad = await d.chat({ model: "p/bad", messages: [] });
    assert.equal(resBad.status, 403);
    assert.equal(resBad.headers.get("x-mslxdff-allowlist"), "1");
    const txt = await resBad.text();
    assert.match(txt, /not allowed/);
    await d.close();
  });

  test("US5 dispatcher 注入 getAllowed 过滤 listModels", async () => {
    const p = {
      id: "p",
      listModels: async () => [{ id: "p/a" }, { id: "p/b" }],
      close: async () => {},
    };
    const d = createProviderDispatcher([p], {
      isAllowed: (id, raw) => raw === "a",
      getAllowedModels: (id) => ["a"],
      getAllowAny: () => false,
    });
    const list = await d.listModels();
    assert.deepEqual(list.map((m) => m.id), ["p/a"]);
    await d.close();
  });

  test("US6 model-id 热路径缓存 0 IO 命中", async () => {
    const { registerModelAlias, getModelAlias } = await import("../src/providers/model-id.js");
    const prev = process.env.MSLXDFF_ALIASES_FILE;
    process.env.MSLXDFF_ALIASES_FILE = "/tmp/mslxdff-alias-nonexistent-12345.json";
    try {
      registerModelAlias("alias-test-123", "canon/test");
      const hit1 = getModelAlias("alias-test-123");
      assert.equal(hit1, "canon/test");
      const hit2 = getModelAlias("alias-test-123");
      assert.equal(hit2, "canon/test");
      // 命中走 Map 缓存，即使文件不存在也不抛
    } finally {
      if (prev === undefined) delete process.env.MSLXDFF_ALIASES_FILE;
      else process.env.MSLXDFF_ALIASES_FILE = prev;
    }
  });
});
