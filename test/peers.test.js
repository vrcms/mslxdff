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

async function stubChatServer(handler) {
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
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
