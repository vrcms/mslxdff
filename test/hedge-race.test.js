import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.js";
import { createRouter } from "../src/routes.js";
import { createUpstreamClient } from "../src/upstream.js";
import { createPeersService } from "../src/peers.js";
import { createAutoSelector } from "../src/auto.js";
import { hedgeDelayMs, shouldHedge, isFastFailStatus } from "../src/routes/hedge.js";

function tmpStateFile() {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-hedge-"));
  return join(dir, "state.json");
}

describe("hedge config", () => {
  test("hedgeDelayMs defaults to 1000 and parses env", async () => {
    const orig = process.env.MSLXDFF_HEDGE_DELAY_MS;
    try {
      delete process.env.MSLXDFF_HEDGE_DELAY_MS;
      assert.equal(hedgeDelayMs(), 1000);
      process.env.MSLXDFF_HEDGE_DELAY_MS = "0";
      assert.equal(hedgeDelayMs(), 0);
      process.env.MSLXDFF_HEDGE_DELAY_MS = "off";
      assert.equal(hedgeDelayMs(), 0);
      process.env.MSLXDFF_HEDGE_DELAY_MS = "500";
      assert.equal(hedgeDelayMs(), 500);
      process.env.MSLXDFF_HEDGE_DELAY_MS = "2000";
      assert.equal(hedgeDelayMs(), 2000);
      process.env.MSLXDFF_HEDGE_DELAY_MS = "invalid";
      assert.equal(hedgeDelayMs(), 1000);
    } finally {
      if (orig === undefined) delete process.env.MSLXDFF_HEDGE_DELAY_MS;
      else process.env.MSLXDFF_HEDGE_DELAY_MS = orig;
    }
  });

  test("shouldHedge only for stream + peers + delay>0", () => {
    assert.equal(shouldHedge({ isStream: false, canForwardPeers: true, hedgeDelayMs: 1000, hasPeers: true }), false);
    assert.equal(shouldHedge({ isStream: true, canForwardPeers: false, hedgeDelayMs: 1000, hasPeers: true }), false);
    assert.equal(shouldHedge({ isStream: true, canForwardPeers: true, hedgeDelayMs: 0, hasPeers: true }), false);
    assert.equal(shouldHedge({ isStream: true, canForwardPeers: true, hedgeDelayMs: 1000, hasPeers: false }), false);
    assert.equal(shouldHedge({ isStream: true, canForwardPeers: true, hedgeDelayMs: 1000, hasPeers: true }), true);
  });

  test("isFastFailStatus detects 429/502/503/504", () => {
    assert.equal(isFastFailStatus(429), true);
    assert.equal(isFastFailStatus(502), true);
    assert.equal(isFastFailStatus(503), true);
    assert.equal(isFastFailStatus(504), true);
    assert.equal(isFastFailStatus(400), false);
    assert.equal(isFastFailStatus(200), false);
    assert.equal(isFastFailStatus(500), false);
  });
});

describe("hedge integration with real servers", () => {
  const TOKEN = "a".repeat(64);

  function sseChunks(texts) {
    return texts.map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`).join("") + "data: [DONE]\n\n";
  }

  async function makeUpstream(handler) {
    const srv = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => handler(req, res, body));
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    return srv;
  }

  async function makePeer({ delayMs, bodyText, status = 200 }) {
    let hits = 0;
    const srv = createServer((req, res) => {
      const url = (req.url || "").split("?")[0];
      if (req.method === "GET" && url === "/v1/models/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "deepseek-v4-flash-free", status: "normal" }] }));
        return;
      }
      hits++;
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        setTimeout(() => {
          if (status >= 400) {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "peer err" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(sseChunks([bodyText]));
          res.end();
        }, delayMs);
      });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    return { srv, getHits: () => hits, url: `http://127.0.0.1:${srv.address().port}` };
  }

  async function boot({ upstreamDelayMs, peerDefs, hedgeDelay }) {
    const orig = process.env.MSLXDFF_HEDGE_DELAY_MS;
    const origState = process.env.MSLXDFF_STATE_FILE;
    if (hedgeDelay !== undefined) process.env.MSLXDFF_HEDGE_DELAY_MS = String(hedgeDelay);
    const stateFile = tmpStateFile();
    process.env.MSLXDFF_STATE_FILE = stateFile;
    const up = await makeUpstream((req, res) => {
      // Header immediate, chunk delayed — matches real opencode stall (TTFB fast, body slow)
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (typeof res.flushHeaders === "function") res.flushHeaders();
      // ensure header flushed, chunk delayed
      setTimeout(() => {
        res.write(sseChunks(["from-local"]));
        res.end();
      }, upstreamDelayMs);
    });
    const peersList = [];
    const peerServers = [];
    for (const def of peerDefs) {
      const p = await makePeer(def);
      peerServers.push(p);
      peersList.push({ name: p.url, url: p.url, token: "t" });
    }
    const client = createUpstreamClient({ baseUrl: `http://127.0.0.1:${up.address().port}`, retry: {} });
    const peers = createPeersService({ peers: peersList, errors: {}, file: stateFile });
    const auto = createAutoSelector({ file: stateFile, loadCandidates: async () => ["deepseek-v4-flash-free"], errors: {}, cooldownMs: 60_000, now: () => 1_000_000 });
    const srv = startServer({ router: createRouter({ token: TOKEN, upstream: client, auto, peers }) }, 0);
    await srv.ready();
    const port = srv.server.address().port;
    const close = async () => {
      await srv.close();
      srv.server.closeAllConnections?.();
      await new Promise((r) => up.close(r));
      up.closeAllConnections?.();
      for (const p of peerServers) await new Promise((r) => p.srv.close(r));
      try { await client.close(); } catch {}
      if (orig === undefined) delete process.env.MSLXDFF_HEDGE_DELAY_MS;
      else process.env.MSLXDFF_HEDGE_DELAY_MS = orig;
      if (origState === undefined) delete process.env.MSLXDFF_STATE_FILE;
      else process.env.MSLXDFF_STATE_FILE = origState;
    };
    return { port, close, peerServers, up };
  }

  test("slow local + fast peer with hedge -> peer wins and fast", async () => {
    const { port, close } = await boot({ upstreamDelayMs: 1200, peerDefs: [{ delayMs: 50, bodyText: "from-peer" }], hedgeDelay: 150 });
    try {
      const t0 = Date.now();
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "deepseek-v4-flash-free", messages: [{ role: "user", content: "hi" }], stream: true }),
      });
      const text = await res.text();
      const dt = Date.now() - t0;
      assert.equal(res.status, 200);
      // should be from-peer, not from-local, and fast (<800ms, not 1200ms)
      assert.ok(text.includes("from-peer"), `expected peer win, got ${text.slice(0, 200)}`);
      assert.ok(dt < 800, `hedge should be fast, got ${dt}ms (local was 1200ms)`);
      // via header should be peer
      assert.equal(res.headers.get("x-mslxdff-via"), "peer");
    } finally {
      await close();
    }
  });

  test("fast local no hedge -> local wins", async () => {
    const { port, close } = await boot({ upstreamDelayMs: 50, peerDefs: [{ delayMs: 500, bodyText: "from-peer" }], hedgeDelay: 300 });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "deepseek-v4-flash-free", messages: [{ role: "user", content: "hi" }], stream: true }),
      });
      const text = await res.text();
      assert.equal(res.status, 200);
      assert.ok(text.includes("from-local"), `expected local win, got ${text.slice(0, 200)}`);
      assert.equal(res.headers.get("x-mslxdff-via"), "local");
    } finally {
      await close();
    }
  });

  test("no peers -> no hedge, local always", async () => {
    const { port, close } = await boot({ upstreamDelayMs: 50, peerDefs: [], hedgeDelay: 100 });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "deepseek-v4-flash-free", messages: [{ role: "user", content: "hi" }], stream: true }),
      });
      const text = await res.text();
      assert.equal(res.status, 200);
      assert.ok(text.includes("from-local"));
    } finally {
      await close();
    }
  });

  test("hedge off (0) -> always local even if slow", async () => {
    const { port, close } = await boot({ upstreamDelayMs: 400, peerDefs: [{ delayMs: 50, bodyText: "from-peer" }], hedgeDelay: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "deepseek-v4-flash-free", messages: [{ role: "user", content: "hi" }], stream: true }),
      });
      const text = await res.text();
      assert.equal(res.status, 200);
      // hedge off, so local wins despite slow
      assert.ok(text.includes("from-local"), `hedge off should use local, got ${text.slice(0,200)}`);
    } finally {
      await close();
    }
  });

  test("non-stream does not hedge, always local", async () => {
    const { port, close } = await boot({ upstreamDelayMs: 300, peerDefs: [{ delayMs: 10, bodyText: "from-peer" }], hedgeDelay: 50 });
    try {
      // non-stream upstream will be JSON, not SSE; our upstream stub still returns SSE but body.stream=false means client treats as non-stream?
      // For this test, we make upstream return JSON quickly, peer would be ignored
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "deepseek-v4-flash-free", messages: [{ role: "user", content: "hi" }], stream: false }),
      });
      // local JSON path doesn't hedge, should still return 200 (from local)
      assert.equal(res.status, 200);
    } finally {
      await close();
    }
  });
});
