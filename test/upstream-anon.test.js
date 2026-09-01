import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createUpstreamClient } from "../src/upstream.js";

function clearAnonEnv() {
  delete process.env.MSLXDFF_OPENCOD_ANON_FIRST;
  delete process.env.MSLXDFF_OPENCOD_ANON;
  delete process.env.MSLXDFF_ANON_FIRST;
}

describe("upstream anon-first", () => {
  afterEach(clearAnonEnv);

  it("默认 buildHeaders 为匿名 hermes", () => {
    clearAnonEnv();
    const c = createUpstreamClient({ baseUrl: "https://example.com", authToken: "public" });
    const h = c.buildHeaders({ stream: true });
    assert.equal(h["Authorization"], "");
    assert.equal(h["User-Agent"], "opencode");
    assert.equal(h["HTTP-Referer"], "https://hermes-agent.nousresearch.com");
    assert.equal(h["X-Title"], "Hermes Agent");
    assert.equal(h["x-opencode-client"], "desktop");
  });

  it("MSLXDFF_OPENCOD_ANON_FIRST=0 回退 public", () => {
    process.env.MSLXDFF_OPENCOD_ANON_FIRST = "0";
    const c = createUpstreamClient({ baseUrl: "https://example.com", authToken: "public" });
    const h = c.buildHeaders({ stream: true });
    assert.equal(h["Authorization"], "Bearer public");
    assert.equal(h["HTTP-Referer"], undefined);
    assert.equal(h["X-Title"], undefined);
    clearAnonEnv();
  });

  it("chat 首发即 anon", async () => {
    clearAnonEnv();
    let firstHeaders = null;
    const fetchImpl = async (url, opts) => {
      if (!firstHeaders) firstHeaders = opts.headers;
      return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const c = createUpstreamClient({ baseUrl: "https://example.com", fetchImpl });
    await c.chat({ model: "big-pickle", messages: [{ role: "user", content: "hi" }] });
    assert.equal(firstHeaders["Authorization"], "");
    assert.equal(firstHeaders["X-Title"], "Hermes Agent");
  });

  it("preheat 头为 anon", async () => {
    clearAnonEnv();
    let preHeaders = null;
    const fetchImpl = async (url, opts) => {
      preHeaders = opts.headers;
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: {} });
    };
    const c = createUpstreamClient({ baseUrl: "https://example.com", fetchImpl });
    await c.preheat();
    assert.equal(preHeaders["Authorization"], "");
    assert.equal(preHeaders["HTTP-Referer"], "https://hermes-agent.nousresearch.com");
  });
});
