import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPeersService, normalizePeerUrl } from "../src/peers.js";
import { createAutoSelector } from "../src/auto.js";
import { startServer } from "../src/server.js";
import { createRouter } from "../src/routes.js";
import { createUpstreamClient } from "../src/upstream.js";
import { createServer } from "node:http";

const TOKEN = "a".repeat(64);

function tmpStateFile() {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-peers-"));
  return join(dir, "state.json");
}

test("normalizePeerUrl strips trailing slashes", () => {
  assert.equal(normalizePeerUrl("http://1.2.3.4:8989/"), "http://1.2.3.4:8989");
  assert.equal(normalizePeerUrl("  http://x.y/  "), "http://x.y");
  assert.equal(normalizePeerUrl(""), "");
});

test("peers add/list/remove persist to state file", () => {
  const file = tmpStateFile();
  const svc = createPeersService({ file });
  assert.ok(svc.add({ name: "vps", url: "http://141.98.198.197:8989/", token: "secret" }));
  assert.equal(svc.all().length, 1);
  assert.equal(svc.all()[0].url, "http://141.98.198.197:8989");

  // reload from disk
  const reloaded = createPeersService({ file });
  assert.equal(reloaded.all().length, 1);
  assert.equal(reloaded.all()[0].name, "vps");
  assert.equal(reloaded.all()[0].token, "secret");

  // duplicate url updates, not appends
  svc.add({ name: "vps2", url: "http://141.98.198.197:8989", token: "other" });
  assert.equal(svc.all().length, 1);
  assert.equal(svc.all()[0].name, "vps2");

  assert.ok(svc.remove("http://141.98.198.197:8989/"));
  assert.equal(svc.all().length, 0);
  assert.equal(svc.remove("http://nope"), false);
});

test("peer cooling makes it unavailable until window passes", async () => {
  let t = 0;
  const svc = createPeersService({
    peers: [{ name: "a", url: "http://a", token: "t" }],
    errors: {},
    now: () => t,
    cooldownMs: 100,
  });
  assert.equal(svc.available().length, 1);
  await svc.recordError("http://a");
  assert.equal(svc.available().length, 0);
  t = 101;
  assert.equal(svc.available().length, 1);
});

test("next() round-robins across available peers", () => {
  let t = 0;
  const svc = createPeersService({
    peers: [
      { name: "a", url: "http://a", token: "t" },
      { name: "b", url: "http://b", token: "t" },
      { name: "c", url: "http://c", token: "t" },
    ],
    errors: {},
    now: () => t,
    cooldownMs: 100,
  });
  const seen = [svc.next().url, svc.next().url, svc.next().url, svc.next().url];
  assert.deepEqual(seen, ["http://a", "http://b", "http://c", "http://a"]);
});

const DEFAULT_STATUS = [
  { id: "deepseek-v4-flash-free", status: "normal", at: null, code: null },
  { id: "mimo-v2.5-free", status: "normal", at: null, code: null },
];

test("recordResult ok warms the hot cache (EMA latency, model, reset fails)", async () => {
  const svc = createPeersService({ peers: [{ name: "a", url: "http://a", token: "t" }], errors: {} });
  await svc.recordResult("http://a", { ok: true, latencyMs: 100, model: "m1-free" });
  let s = svc.stat("http://a");
  assert.equal(s.latencyMs, 100);
  assert.equal(s.model, "m1-free");
  assert.equal(s.fails, 0);
  assert.ok(s.okAt > 0);
  assert.equal(svc.isHot("http://a"), true);

  // EMA blend on second success
  await svc.recordResult("http://a", { ok: true, latencyMs: 200, model: "m1-free" });
  s = svc.stat("http://a");
  assert.equal(s.latencyMs, Math.round(100 * 0.7 + 200 * 0.3));

  // failure bumps fails, does not clear okAt
  await svc.recordResult("http://a", { ok: false });
  s = svc.stat("http://a");
  assert.equal(s.fails, 1);
  assert.equal(svc.isHot("http://a"), true);
});

test("ordered() puts hot fast peers first, cold peers last", async () => {
  const t = 1_000_000;
  const svc = createPeersService({
    peers: [
      { name: "a", url: "http://a", token: "t" },
      { name: "b", url: "http://b", token: "t" },
      { name: "c", url: "http://c", token: "t" },
    ],
    errors: {},
    stats: {
      "http://b": { okAt: t - 1_000, latencyMs: 50, fails: 0, model: "m" },   // hot, fast
      "http://c": { okAt: t - 2_000, latencyMs: 400, fails: 0, model: "m" },  // hot, slow
      "http://a": { okAt: t - 10_000_000, latencyMs: 80, fails: 0, model: "m" }, // cold (expired)
    },
    now: () => t,
    heatMs: 60_000,
    cooldownMs: 60_000,
  });
  const order = svc.ordered().map((p) => p.url);
  assert.deepEqual(order, ["http://b", "http://c", "http://a"]);
});

test("isHot false after heat window or during cooldown", async () => {
  const t = 1_000_000;
  const svc = createPeersService({
    peers: [{ name: "a", url: "http://a", token: "t" }],
    errors: { "http://a": t - 1 },
    stats: { "http://a": { okAt: t - 1_000, latencyMs: 10, fails: 0, model: "m" } },
    now: () => t,
    heatMs: 60_000,
    cooldownMs: 60_000,
  });
  assert.equal(svc.isHot("http://a"), false, "cooling peer is not hot");
});

test("isHot expires after heatMs", async () => {
  let t = 1_000_000;
  const svc = createPeersService({
    peers: [{ name: "a", url: "http://a", token: "t" }],
    errors: {},
    stats: { "http://a": { okAt: t, latencyMs: 10, fails: 0, model: "m" } },
    now: () => t,
    heatMs: 60_000,
    cooldownMs: 60_000,
  });
  assert.equal(svc.isHot("http://a"), true);
  t = 1_000_000 + 60_001;
  assert.equal(svc.isHot("http://a"), false);
});

async function stubChatServer(onChat, onStatus) {
  const srv = createServer((req, res) => {
    const url = (req.url || "").split("?")[0];
    if (req.method === "GET" && url === "/v1/models/status") {
      if (onStatus) {
        if (onStatus.length >= 2) return onStatus(req, res);
        const data = onStatus();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: "list", data }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: DEFAULT_STATUS }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => onChat(req, res, body));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", () => r()));
  return srv;
}

async function boot({ upstreamHandler, peers }) {
  const up = await stubChatServer(upstreamHandler);
  const client = createUpstreamClient({
    baseUrl: `http://127.0.0.1:${up.address().port}`,
    retry: {},
  });
  const auto = createAutoSelector({
    loadCandidates: async () => ["deepseek-v4-flash-free", "mimo-v2.5-free"],
    errors: {},
    cooldownMs: 60_000,
    now: () => 1_000_000,
  });
  const srv = startServer({ router: createRouter({ token: TOKEN, upstream: client, auto, peers }) }, 0);
  await srv.ready();
  return {
    srv,
    port: srv.server.address().port,
    close: async () => {
      await srv.close();
      srv.server.closeAllConnections?.();
      await new Promise((r) => up.close(r));
      up.closeAllConnections?.();
    },
  };
}

async function postChat(app, body, extraHeaders = {}) {
  return fetch(`http://127.0.0.1:${app.port}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

test("local success does not touch peers", async () => {
  const seen = [];
  const peerSrv = await stubChatServer((req, res, body) => {
    seen.push("peer");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  const peers = createPeersService({
    peers: [{ name: "p", url: `http://127.0.0.1:${peerSrv.address().port}`, token: "t" }],
    errors: {},
  });
  const app = await boot({
    upstreamHandler: (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
    peers,
  });
  try {
    const res = await postChat(app, { model: "deepseek-v4-flash-free", messages: [] });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, [], "peers must not be contacted when local works");
  } finally {
    await app.close();
    await new Promise((r) => peerSrv.close(r));
  }
});

test("local model fails -> falls back to peer with same model (model-lock header)", async () => {
  const seenPeers = [];
  const peerSrv = await stubChatServer((req, res, body) => {
    seenPeers.push({ model: JSON.parse(body).model, lock: req.headers["x-mslxdff-model-lock"], hops: req.headers["x-mslxdff-hops"] });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ from: "peer", model: JSON.parse(body).model }));
  });
  const peers = createPeersService({
    peers: [{ name: "p", url: `http://127.0.0.1:${peerSrv.address().port}`, token: "ptoken" }],
    errors: {},
    now: () => 1_000_000,
  });
  const app = await boot({
    upstreamHandler: (req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "local down" }));
    },
    peers,
  });
  try {
    const res = await postChat(app, { model: "deepseek-v4-flash-free", messages: [] });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.from, "peer");
    assert.equal(seenPeers.length, 1);
    assert.equal(seenPeers[0].model, "deepseek-v4-flash-free");
    assert.equal(seenPeers[0].lock, "deepseek-v4-flash-free");
    assert.equal(seenPeers[0].hops, "1");
    assert.ok(peers.errors()["http://127.0.0.1:" + peerSrv.address().port] === undefined, "successful peer not recorded as error");
  } finally {
    await app.close();
    await new Promise((r) => peerSrv.close(r));
  }
});

test("peer error recorded; request falls to next candidate model", async () => {
  const peerSrv = await stubChatServer((req, res) => {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "peer down" }));
  });
  const peers = createPeersService({
    peers: [{ name: "p", url: `http://127.0.0.1:${peerSrv.address().port}`, token: "t" }],
    errors: {},
    now: () => 1_000_000,
  });
  const app = await boot({
    upstreamHandler: (req, res, body) => {
      const model = JSON.parse(body).model;
      if (model === "deepseek-v4-flash-free") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "local down" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model, ok: true }));
    },
    peers,
  });
  try {
    const res = await postChat(app, { model: "deepseek-v4-flash-free", messages: [] });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.model, "mimo-v2.5-free", "falls through to next candidate after peer fails");
    assert.ok(peers.errors()[`http://127.0.0.1:${peerSrv.address().port}`], "peer error must be recorded");
  } finally {
    await app.close();
    await new Promise((r) => peerSrv.close(r));
  }
});

test("peer in cooldown is skipped; local fallback to next model", async () => {
  let t = 1_000_000;
  const peerSrv = await stubChatServer((req, res) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "peer down" }));
  });
  const peerUrl = `http://127.0.0.1:${peerSrv.address().port}`;
  const peers = createPeersService({
    peers: [{ name: "p", url: peerUrl, token: "t" }],
    errors: { [peerUrl]: 1_000_000 - 5 }, // cooling
    now: () => t,
    cooldownMs: 60_000,
  });
  const app = await boot({
    upstreamHandler: (req, res, body) => {
      const model = JSON.parse(body).model;
      if (model === "deepseek-v4-flash-free") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "local down" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model, ok: true }));
    },
    peers,
  });
  try {
    const res = await postChat(app, { model: "deepseek-v4-flash-free", messages: [] });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.model, "mimo-v2.5-free");
    assert.equal(json.ok, true);
  } finally {
    await app.close();
    await new Promise((r) => peerSrv.close(r));
  }
});

test("incoming request with x-mslxdff-hops >= maxHops does not forward to peers", async () => {
  let peerHit = false;
  const peerSrv = await stubChatServer((req, res) => {
    peerHit = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  const peers = createPeersService({
    peers: [{ name: "p", url: `http://127.0.0.1:${peerSrv.address().port}`, token: "t" }],
    errors: {},
  });
  const app = await boot({
    upstreamHandler: (req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "down" }));
    },
    peers,
  });
  try {
    // hops already at maxHops (default 3) -> no peer forward
    const res = await postChat(app, { model: "deepseek-v4-flash-free", messages: [] }, { "x-mslxdff-hops": "3" });
    assert.equal(res.status, 500);
    assert.equal(peerHit, false, "peers must not be contacted when hops exhausted");
  } finally {
    await app.close();
    await new Promise((r) => peerSrv.close(r));
  }
});

test("peer only exposes healthy models: forwards the healthy one with lock", async () => {
  const seenPeers = [];
  const peerSrv = await stubChatServer(
    (req, res, body) => {
      seenPeers.push({ model: JSON.parse(body).model, lock: req.headers["x-mslxdff-model-lock"] });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ from: "peer", model: JSON.parse(body).model }));
    },
    () => [
      { id: "m1-free", status: "normal", at: null, code: null },
      { id: "m2-free", status: "limit", at: 123, code: 429 },
      { id: "m3-free", status: "error", at: 456, code: 503 },
    ]
  );
  const peers = createPeersService({
    peers: [{ name: "p", url: `http://127.0.0.1:${peerSrv.address().port}`, token: "t" }],
    errors: {},
  });
  const app = await boot({
    upstreamHandler: (req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "local down" }));
    },
    peers,
  });
  try {
    const res = await postChat(app, { model: "deepseek-v4-flash-free", messages: [] });
    assert.equal(res.status, 200);
    assert.equal(seenPeers.length, 1);
    assert.equal(seenPeers[0].model, "m1-free", "unhealthy peer models must not be requested");
    assert.equal(seenPeers[0].lock, "m1-free");
  } finally {
    await app.close();
    await new Promise((r) => peerSrv.close(r));
  }
});

test("peer with no healthy models is skipped; local fallback serves", async () => {
  let peerChatHits = 0;
  const peerSrv = await stubChatServer(
    (req, res) => {
      peerChatHits++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    },
    () => [
      { id: "m1-free", status: "limit", at: 123, code: 429 },
      { id: "m2-free", status: "error", at: 456, code: 503 },
    ]
  );
  const peers = createPeersService({
    peers: [{ name: "p", url: `http://127.0.0.1:${peerSrv.address().port}`, token: "t" }],
    errors: {},
  });
  const app = await boot({
    upstreamHandler: (req, res, body) => {
      const model = JSON.parse(body).model;
      if (model === "deepseek-v4-flash-free") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "local down" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model, ok: true }));
    },
    peers,
  });
  try {
    const res = await postChat(app, { model: "deepseek-v4-flash-free", messages: [] });
    assert.equal(res.status, 200);
    assert.equal(peerChatHits, 0, "chat must not be forwarded to a peer without healthy models");
    const json = await res.json();
    assert.equal(json.model, "mimo-v2.5-free", "local fallback serves instead");
    assert.ok(peers.errors()[`http://127.0.0.1:${peerSrv.address().port}`], "unhealthy peer recorded for cooldown");
  } finally {
    await app.close();
    await new Promise((r) => peerSrv.close(r));
  }
});

test("hot peer is reused without a status probe", async () => {
  let statusHits = 0;
  const seenPeers = [];
  const peerSrv = await stubChatServer(
    (req, res, body) => {
      seenPeers.push({ model: JSON.parse(body).model, lock: req.headers["x-mslxdff-model-lock"] });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ from: "peer", model: JSON.parse(body).model }));
    },
    () => {
      statusHits++;
      return [{ id: "probed-free", status: "normal" }];
    }
  );
  const peerUrl = `http://127.0.0.1:${peerSrv.address().port}`;
  const peers = createPeersService({
    peers: [{ name: "p", url: peerUrl, token: "t" }],
    errors: {},
    stats: { [peerUrl]: { okAt: Date.now(), latencyMs: 100, fails: 0, model: "remembered-free" } },
  });
  const app = await boot({
    upstreamHandler: (req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "local down" }));
    },
    peers,
  });
  try {
    const res = await postChat(app, { model: "deepseek-v4-flash-free", messages: [] });
    assert.equal(res.status, 200);
    assert.equal(statusHits, 0, "hot peer must not be probed");
    assert.equal(seenPeers.length, 1);
    assert.equal(seenPeers[0].model, "remembered-free", "reuses the remembered model");
  } finally {
    await app.close();
    await new Promise((r) => peerSrv.close(r));
  }
});

test("hot peer model fails -> one probe retries with a healthy model", async () => {
  const seenModels = [];
  const peerSrv = await stubChatServer(
    (req, res, body) => {
      const m = JSON.parse(body).model;
      seenModels.push(m);
      if (m === "stale-free") {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "model gone" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ from: "peer", model: m }));
    },
    () => [{ id: "fresh-free", status: "normal" }]
  );
  const peerUrl = `http://127.0.0.1:${peerSrv.address().port}`;
  const peers = createPeersService({
    peers: [{ name: "p", url: peerUrl, token: "t" }],
    errors: {},
    stats: { [peerUrl]: { okAt: Date.now(), latencyMs: 100, fails: 0, model: "stale-free" } },
  });
  const app = await boot({
    upstreamHandler: (req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "local down" }));
    },
    peers,
  });
  try {
    const res = await postChat(app, { model: "deepseek-v4-flash-free", messages: [] });
    assert.equal(res.status, 200);
    assert.deepEqual(seenModels, ["stale-free", "fresh-free"], "probe retry after stale model miss");
    const stat = peers.stat(peerUrl);
    assert.equal(stat.model, "fresh-free", "cache updated with the probed model");
    assert.equal(stat.fails, 0);
  } finally {
    await app.close();
    await new Promise((r) => peerSrv.close(r));
  }
});

test("peer status endpoint unreachable -> peer skipped, local fallback serves", async () => {
  // peer stub only answers /v1/chat/completions (no /v1/models/status)
  const peerSrv = await stubChatServer(
    (req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    },
    (req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
  );
  const peers = createPeersService({
    peers: [{ name: "p", url: `http://127.0.0.1:${peerSrv.address().port}`, token: "t" }],
    errors: {},
  });
  const app = await boot({
    upstreamHandler: (req, res, body) => {
      const model = JSON.parse(body).model;
      if (model === "deepseek-v4-flash-free") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "local down" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model, ok: true }));
    },
    peers,
  });
  try {
    const res = await postChat(app, { model: "deepseek-v4-flash-free", messages: [] });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.model, "mimo-v2.5-free", "unreachable peer skipped, local fallback serves");
  } finally {
    await app.close();
    await new Promise((r) => peerSrv.close(r));
  }
});
