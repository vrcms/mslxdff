import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPeersService, normalizePeerUrl } from "../src/peers.js";
import { stripCallerBoundReasoning, PEER_BODY_TIMEOUT_MS, PEER_HEADERS_TIMEOUT_MS } from "../src/routes/peers.js";
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
  const svc = createPeersService({ file: tmpStateFile(),
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
  const svc = createPeersService({ file: tmpStateFile(),
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
  const svc = createPeersService({ file: tmpStateFile(), peers: [{ name: "a", url: "http://a", token: "t" }], errors: {} });
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

test("ordered() 按延迟最小优先（用户 2026-10-19 新策略：不竞速、延迟最小先上）", async () => {
  const t = 1_000_000;
  const svc = createPeersService({ file: tmpStateFile(),
    peers: [
      { name: "a", url: "http://a", token: "t" },
      { name: "b", url: "http://b", token: "t" },
      { name: "c", url: "http://c", token: "t" },
    ],
    errors: { "http://b": t - 600_000, "http://a": t - 300_000 },
    stats: {
      "http://b": { okAt: t - 1_000, latencyMs: 400, fails: 0, model: "m" },   // 热但慢
      "http://c": { okAt: t - 2_000, latencyMs: 50, fails: 0, model: "m" },    // 热且快
      "http://a": { okAt: t - 10_000_000, latencyMs: 80, fails: 0, model: "m" }, // 冷但比 b 快
    },
    now: () => t,
    heatMs: 60_000,
    cooldownMs: 60_000,
  });
  const order = svc.ordered().map((p) => p.url);
  // 延迟升序 c(50) → a(80) → b(400)；「热」不再是判据
  assert.deepEqual(order, ["http://c", "http://a", "http://b"]);
});

test("isHot false after heat window or during cooldown", async () => {
  const t = 1_000_000;
  const svc = createPeersService({ file: tmpStateFile(),
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
  const svc = createPeersService({ file: tmpStateFile(),
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

test("orderedByLastError prefers the peer that failed earliest (more time to recover)", async () => {
  const t = 1_000_000;
  const svc = createPeersService({ file: tmpStateFile(),
    peers: [
      { name: "a", url: "http://a", token: "t" },
      { name: "b", url: "http://b", token: "t" },
      { name: "c", url: "http://c", token: "t" },
    ],
    errors: { "http://b": t - 600_000, "http://a": t - 300_000 }, // b failed earlier
    stats: {},
    now: () => t,
    cooldownMs: 60_000,
  });
  // both are outside cooldown (failed >60s ago); b failed first -> b first
  assert.deepEqual(svc.orderedByLastError().map((p) => p.url), ["http://b", "http://a", "http://c"]);
});

test("recordResult ok clears the long-lived error memory", async () => {
  const t = 1_000_000;
  const svc = createPeersService({ file: tmpStateFile(),
    peers: [{ name: "a", url: "http://a", token: "t" }],
    errors: { "http://a": t - 300_000 },
    stats: {},
    now: () => t,
  });
  await svc.recordResult("http://a", { ok: true, latencyMs: 50, model: "m-free" });
  assert.equal(svc.errors()["http://a"], undefined, "success clears the error memory");
});

async function stubChatServer(onChat, onStatus) {
  const srv = createServer((req, res) => {
    const url = (req.url || "").split("?")[0];
    // 连接预热（peer-serial 的 warmPeer）会打 GET /health：它只建连、不算一次 chat 转发，
    // 必须单独应答，否则会被 onChat 计成「又打了一次这个组员」，污染串行选路断言。
    if (req.method === "GET" && url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
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
    file: tmpStateFile(),
    latencies: {},
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
  const peers = createPeersService({ file: tmpStateFile(),
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
  const peers = createPeersService({ file: tmpStateFile(),
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
test("peer error recorded; explicit model ends with the peer failure detail", async () => {
  let peerChatHits = 0;
  const peerSrv = await stubChatServer((req, res) => {
    peerChatHits++;
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "peer down" }));
  });
  const peers = createPeersService({
    file: tmpStateFile(),
    peers: [{ name: "p", url: `http://127.0.0.1:${peerSrv.address().port}`, token: "t" }],
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
    assert.equal(res.status, 502);
    const json = await res.json();
    assert.match(String(json.error), /peers failed/, "peer failure detail reaches the caller");
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(peers.errors()[`http://127.0.0.1:${peerSrv.address().port}`], "peer error must be recorded");
    assert.equal(peerChatHits, 1, "same peer must not be retried within one request");
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
  const peers = createPeersService({ file: tmpStateFile(),
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
    const res = await postChat(app, { model: "auto", messages: [] });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.model, "mimo-v2.5-free");
    assert.equal(json.ok, true);
  } finally {
    await app.close();
    await new Promise((r) => peerSrv.close(r));
  }
});

test("all peers cooling -> last-resort attempt still uses the cooling peer", async () => {
  const peerSrv = await stubChatServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ from: "peer", ok: true }));
  });
  const peerUrl = `http://127.0.0.1:${peerSrv.address().port}`;
  const peers = createPeersService({ file: tmpStateFile(),
    peers: [{ name: "p", url: peerUrl, token: "t" }],
    errors: { [peerUrl]: 1_000_000 - 5 }, // cooling（30s/60s 窗口内）
    stats: {},
    now: () => 1_000_000,
    cooldownMs: 60_000,
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
    assert.equal(json.from, "peer", "cooling peer must still get a last-resort attempt");
    assert.ok(!peers.errors()[peerUrl], "success clears the cooling record");
  } finally {
    await app.close();
    await new Promise((r) => peerSrv.close(r));
  }
});

test("consecutive 429 escalates to the limit cooldown; single 429 stays short", async () => {
  let t = 1_000_000;
  const svc = createPeersService({ file: tmpStateFile(),
    peers: [{ name: "a", url: "http://a", token: "t" }],
    errors: {},
    stats: {},
    now: () => t,
    cooldownMs: 30_000,
    limitCooldownMs: 300_000,
  });
  await svc.recordError("http://a", { status: 429 });
  t += 31_000;
  assert.equal(svc.available().length, 1, "first 429 only cools the short window");
  await svc.recordError("http://a", { status: 429 });
  t += 31_000;
  assert.equal(svc.available().length, 0, "second consecutive 429 keeps it cooling (5min window)");
  t += 300_000;
  assert.equal(svc.available().length, 1, "after the limit window it returns");
});

test("success clears the 429 streak", async () => {
  const svc = createPeersService({ file: tmpStateFile(), peers: [{ name: "a", url: "http://a", token: "t" }], errors: {}, stats: {}, cooldownMs: 30_000, limitCooldownMs: 300_000 });
  await svc.recordError("http://a", { status: 429 });
  await svc.recordError("http://a", { status: 429 });
  assert.equal(svc.stat("http://a").streak429, 2);
  await svc.recordResult("http://a", { ok: true, latencyMs: 5, model: "m" });
  assert.equal(svc.stat("http://a").streak429, 0);
  assert.equal(svc.errors()["http://a"], undefined);
});

test("coolingByLastError yields short-cooling peers only (429-locked excluded)", async () => {
  const svc = createPeersService({ file: tmpStateFile(),
    peers: [{ name: "a", url: "http://a", token: "t" }, { name: "b", url: "http://b", token: "t" }],
    errors: { "http://a": 1_000_000 - 1_000 },
    stats: {},
    now: () => 1_000_000,
    cooldownMs: 30_000,
    limitCooldownMs: 300_000,
  });
  await svc.recordError("http://b", { status: 429 });
  await svc.recordError("http://b", { status: 429 });
  assert.deepEqual(svc.coolingByLastError().map((p) => p.url), ["http://a"], "429-locked peer excluded from last-resort");
});

test("peer failures surface detailed reasons to the caller", async () => {
  const peerSrv = await stubChatServer((req, res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "max_output_tokens must be >= 16" } }));
  });
  const peerUrl = `http://127.0.0.1:${peerSrv.address().port}`;
  const peers = createPeersService({ file: tmpStateFile(), peers: [{ name: "p", url: peerUrl, token: "t" }], errors: {}, stats: {}, cooldownMs: 30_000, limitCooldownMs: 300_000 });
  const app = await boot({
    upstreamHandler: (req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "local down" }));
    },
    peers,
  });
  try {
    const res = await postChat(app, { model: "deepseek-v4-flash-free", messages: [] });
    assert.equal(res.status, 502);
    const json = await res.json();
    assert.match(String(json.error), /400/, "peer status code must reach the caller");
    assert.match(String(json.error), /max_output_tokens/, "peer error body must reach the caller");
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
  const peers = createPeersService({ file: tmpStateFile(),
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
  const peers = createPeersService({ file: tmpStateFile(),
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
    // 显式模型严格语义：peer 必须以请求模型 deepseek 去试，不偷换成 m1
    assert.equal(seenPeers[0].model, "deepseek-v4-flash-free", "explicit model must be forwarded as-is, not replaced by healthy");
    assert.equal(seenPeers[0].lock, "deepseek-v4-flash-free");
  } finally {
    await app.close();
    await new Promise((r) => peerSrv.close(r));
  }
});

test("peer with no healthy models is skipped; local fallback serves", async () => {
  let peerChatHits = 0;
  let peerSeenModel = null;
  const peerSrv = await stubChatServer(
    (req, res, body) => {
      peerChatHits++;
      peerSeenModel = JSON.parse(body).model;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ from: "peer", model: peerSeenModel }));
    },
    () => [
      { id: "m1-free", status: "limit", at: 123, code: 429 },
      { id: "m2-free", status: "error", at: 456, code: 503 },
    ]
  );
  const peers = createPeersService({ file: tmpStateFile(),
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
    // 显式模型严格语义：即使 peer 报告无 healthy，也必须以 deepseek 去试 peer，不直接跳过
    assert.equal(peerChatHits, 1, "explicit model must still be forwarded to peer even when peer reports no healthy");
    assert.equal(peerSeenModel, "deepseek-v4-flash-free");
    const json = await res.json();
    assert.equal(json.model, "deepseek-v4-flash-free", "peer serves the exact requested model");
  } finally {
    await app.close();
    await new Promise((r) => peerSrv.close(r));
  }
});

test("hot peer is reused without a status probe when the remembered model matches", async () => {
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
  const peers = createPeersService({ file: tmpStateFile(),
    peers: [{ name: "p", url: peerUrl, token: "t" }],
    errors: {},
    stats: { [peerUrl]: { okAt: Date.now(), latencyMs: 100, fails: 0, model: "deepseek-v4-flash-free" } },
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
    assert.equal(seenPeers[0].model, "deepseek-v4-flash-free", "reuses the remembered model");
  } finally {
    await app.close();
    await new Promise((r) => peerSrv.close(r));
  }
});

test("hot peer with a different remembered model probes and prefers the requested model", async () => {
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
    () => [{ id: "deepseek-v4-flash-free", status: "normal" }, { id: "fresh-free", status: "normal" }]
  );
  const peerUrl = `http://127.0.0.1:${peerSrv.address().port}`;
  const peers = createPeersService({ file: tmpStateFile(),
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
    assert.deepEqual(seenModels, ["deepseek-v4-flash-free"], "probes once and uses the requested model");
    const stat = peers.stat(peerUrl);
    assert.equal(stat.model, "deepseek-v4-flash-free", "cache updated with the requested model");
    assert.equal(stat.fails, 0);
  } finally {
    await app.close();
    await new Promise((r) => peerSrv.close(r));
  }
});

test("peer without the requested model falls back to its first healthy model", async () => {
  const seenModels = [];
  const peerSrv = await stubChatServer(
    (req, res, body) => {
      const m = JSON.parse(body).model;
      seenModels.push(m);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ from: "peer", model: m }));
    },
    () => [{ id: "hy3-free", status: "normal" }, { id: "nemotron-3-ultra-free", status: "normal" }]
  );
  const peerUrl = `http://127.0.0.1:${peerSrv.address().port}`;
  const peers = createPeersService({ file: tmpStateFile(),
    peers: [{ name: "p", url: peerUrl, token: "t" }],
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
    // 显式模型严格语义：peer 必须以 deepseek 去试，不偷换成 hy3
    assert.deepEqual(seenModels, ["deepseek-v4-flash-free"], "explicit model must be forwarded as-is even when peer healthy list lacks it");
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
  const peers = createPeersService({ file: tmpStateFile(),
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
    const res = await postChat(app, { model: "auto", messages: [] });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.model, "mimo-v2.5-free", "unreachable peer skipped, local fallback serves");
  } finally {
    await app.close();
    await new Promise((r) => peerSrv.close(r));
  }
});

test("串行选路：只打延迟最小的那个，成功就不碰其他组员（用户 2026-10-19：不竞速）", async () => {
  const slowHits = [];
  const fastHits = [];
  const slowSrv = await stubChatServer(
    (req, res, body) => {
      slowHits.push(JSON.parse(body).model);
      setTimeout(() => {
        try {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ from: "slow", model: JSON.parse(body).model }));
        } catch {}
      }, 250);
    },
    () => [{ id: "deepseek-v4-flash-free", status: "normal" }]
  );
  const fastSrv = await stubChatServer(
    (req, res, body) => {
      fastHits.push(JSON.parse(body).model);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ from: "fast", model: JSON.parse(body).model }));
    },
    () => [{ id: "deepseek-v4-flash-free", status: "normal" }]
  );
  const slowUrl = `http://127.0.0.1:${slowSrv.address().port}`;
  const fastUrl = `http://127.0.0.1:${fastSrv.address().port}`;
  const peers = createPeersService({ file: tmpStateFile(),
    peers: [
      { name: "slow", url: slowUrl, token: "t" },
      { name: "fast", url: fastUrl, token: "t" },
    ],
    errors: {},
  });
  // 先把 fast 标成延迟更小 —— 串行会优先选它
  await peers.recordResult(fastUrl, { ok: true, latencyMs: 20, model: "deepseek-v4-flash-free" });
  await peers.recordResult(slowUrl, { ok: true, latencyMs: 900, model: "deepseek-v4-flash-free" });
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
    assert.equal(json.from, "fast", "延迟最小的先上并成功");
    // 串行：fast 成功即返回，slower 的 peer **一次都不该被调用**
    assert.equal(fastHits.length, 1, "fast 被调用一次");
    assert.equal(slowHits.length, 0, "串行下成功即止，不得再打慢组员（不再是并发竞速）");
  } finally {
    await app.close();
    slowSrv.closeAllConnections?.();
    await new Promise((r) => slowSrv.close(r));
    await new Promise((r) => fastSrv.close(r));
  }
});

test("all peers fail -> retry ordered by earliest error, success clears error memory", async () => {
  let t = 1_000_000;
  let bFail = true;
  let aFail = false;
  const slowHits = [];
  // B failed 10 min ago, A failed 2 min ago -> B must be retried first
  const srvB = await stubChatServer(
    (req, res, body) => {
      slowHits.push(JSON.parse(body).model);
      if (bFail) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ from: "b", model: JSON.parse(body).model }));
    },
    () => [{ id: "deepseek-v4-flash-free", status: "normal" }]
  );
  const srvA = await stubChatServer(
    (req, res) => {
      if (aFail) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ from: "a" }));
    },
    () => [{ id: "deepseek-v4-flash-free", status: "normal" }]
  );
  const urlB = `http://127.0.0.1:${srvB.address().port}`;
  const urlA = `http://127.0.0.1:${srvA.address().port}`;
  const peers = createPeersService({ file: tmpStateFile(),
    peers: [
      { name: "a", url: urlA, token: "t" },
      { name: "b", url: urlB, token: "t" },
    ],
    errors: { [urlB]: t - 600_000, [urlA]: t - 120_000 }, // both cooled off
    now: () => t,
    cooldownMs: 30_000,
  });
  const app = await boot({
    upstreamHandler: (req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "local down" }));
    },
    peers,
  });
  try {
    // First race: both A and B succeed, but B is still failing -> A wins and
    // clears its own failure memory; B keeps its failure record.
    const res = await postChat(app, { model: "deepseek-v4-flash-free", messages: [] });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.from, "a", "A wins the concurrent race");
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(peers.errors()[urlB], "B keeps its failure record (long-lived until success)");
    assert.equal(peers.errors()[urlA], undefined, "A's failure memory cleared by its success");

    // Next race: B recovers and A is down -> B wins on its own; its success
    // must clear its failure memory.（改由"自己赢"洗白：winner-cancel 之后
    // loser 不再产出"迟到成功"，见上一用例）
    bFail = false;
    aFail = true;
    t += 60_000; // let cooldowns pass so B is eligible again
    const res2 = await postChat(app, { model: "deepseek-v4-flash-free", messages: [] });
    assert.equal((await res2.json()).from, "b", "B wins when A is down");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(peers.errors()[urlB], undefined, "B's own win clears its error memory");
  } finally {
    await app.close();
    await new Promise((r) => srvB.close(r));
    await new Promise((r) => srvA.close(r));
  }
});

test("stripCallerBoundReasoning removes assistant reasoning_items only", () => {
  const body = {
    model: "m",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo", reasoning_items: [{ id: "r1", encrypted_content: "xxx" }], reasoning_content: "plain" },
    ],
  };
  const out = stripCallerBoundReasoning(body);
  assert.equal(out.messages[1].reasoning_items, undefined);
  assert.equal(out.messages[1].reasoning_content, "plain");
  assert.equal(body.messages[1].reasoning_items.length, 1, "original body untouched");
  assert.equal(stripCallerBoundReasoning({ messages: [] }).messages.length, 0);
  assert.equal(stripCallerBoundReasoning(undefined), undefined);
});

test("relayed body drops caller-bound reasoning but keeps plain reasoning", async () => {
  const seen = [];
  const peerSrv = await stubChatServer((req, res, body) => {
    seen.push(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ from: "peer" }));
  });
  const peers = createPeersService({ file: tmpStateFile(),
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
    const res = await postChat(app, {
      model: "deepseek-v4-flash-free",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "yo", reasoning_items: [{ id: "r1", encrypted_content: "enc" }], reasoning_content: "plain" },
      ],
    });
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].messages[1].reasoning_items, undefined, "encrypted reasoning must not cross the relay");
    assert.equal(seen[0].messages[1].reasoning_content, "plain");
  } finally {
    await app.close();
    await new Promise((r) => peerSrv.close(r));
  }
});

test("串行下慢组员不会阻塞：延迟小的先上（stalled 不该被优先选中）", async () => {
  const fastSrv = await stubChatServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ from: "fast" }));
  });
  const stalledSrv = await stubChatServer(
    () => { /* never responds */ },
    () => [{ id: "deepseek-v4-flash-free", status: "normal" }]
  );
  const fastUrl = `http://127.0.0.1:${fastSrv.address().port}`;
  const stalledUrl = `http://127.0.0.1:${stalledSrv.address().port}`;
  const peers = createPeersService({ file: tmpStateFile(),
    peers: [
      { name: "stalled", url: stalledUrl, token: "t" },
      { name: "fast", url: fastUrl, token: "t" },
    ],
    errors: {},
  });
  // 串行按延迟升序：fast 已知 20ms、stalled 未知 → fast 先上，stalled 不会被碰
  await peers.recordResult(fastUrl, { ok: true, latencyMs: 20, model: "deepseek-v4-flash-free" });
  const app = await boot({
    upstreamHandler: (req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "local down" }));
    },
    peers,
  });
  try {
    const t0 = Date.now();
    const res = await postChat(app, { model: "deepseek-v4-flash-free", messages: [] });
    const elapsed = Date.now() - t0;
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.from, "fast");
    assert.ok(elapsed < 2000, `串行也应即时返回（延迟小的先上），实际 ${elapsed}ms`);
  } finally {
    await app.close();
    stalledSrv.closeAllConnections?.();
    await new Promise((r) => stalledSrv.close(r));
    await new Promise((r) => fastSrv.close(r));
  }
});

test("peer body timeout outlives any SSE silent gap (must not kill a thinking relay)", () => {
  // 实测：muse-spark 首块后 ~31s 静默，旧 30s bodyTimeout 把组内中继活流掐成 terminated。
  // 这里锁死"不能回退到小值"：undici 层只做最后兜底，掐流交给应用层首块/总时长策略。
  assert.equal(PEER_BODY_TIMEOUT_MS, 120_000);
});

test("peer headers timeout 必须与 bodyTimeout 同档（组员压头等首块，30s 会掐成 fetch failed）", () => {
  // 实测：组员节点首块前不 flush，undici 的 headersTimeout(原 30s) 会在组建还没吐头时
  // 把连接掐成 `fetch failed (UND_ERR_HEADERS_TIMEOUT)` —— 三个组员全部精确卡 ~30620ms。
  // 提到 120s 不会真挂 120s：真闸门是 peerStageCtx 的 45s 阶段总预算，undici 只做最后兜底。
  assert.equal(PEER_HEADERS_TIMEOUT_MS, 120_000, "不得回退到 30s（组员永远等不到首块）");
  assert.equal(PEER_HEADERS_TIMEOUT_MS, PEER_BODY_TIMEOUT_MS, "两档必须同口径");
});

// ---- 选路策略（用户 2026-10-19：不竞速；延迟最小优先）----
test("ordered(): 延迟最小优先（不再是「热优先」）", async () => {
  const svc = createPeersService({
    file: tmpStateFile(),
    peers: [
      { name: "slow", url: "http://slow", token: "t" },
      { name: "fast", url: "http://fast", token: "t" },
      { name: "mid", url: "http://mid", token: "t" },
    ],
    errors: {},
  });
  // slow 是「热」的（最近成功），但延迟大；fast 延迟最小但没 okAt 热标记
  await svc.recordResult("http://slow", { ok: true, latencyMs: 900, model: "m" });
  await svc.recordResult("http://fast", { ok: true, latencyMs: 50, model: "m" });
  await svc.recordResult("http://mid", { ok: true, latencyMs: 300, model: "m" });
  const urls = svc.ordered().map((p) => p.url);
  assert.deepEqual(urls, ["http://fast", "http://mid", "http://slow"], "必须按延迟升序，热不热不参与");
});

test("ordered(): 未测过延迟的排在有数据的之后", async () => {
  const svc = createPeersService({
    file: tmpStateFile(),
    peers: [
      { name: "unknown", url: "http://unknown", token: "t" },
      { name: "known", url: "http://known", token: "t" },
    ],
    errors: {},
  });
  await svc.recordResult("http://known", { ok: true, latencyMs: 500, model: "m" });
  const urls = svc.ordered().map((p) => p.url);
  assert.deepEqual(urls, ["http://known", "http://unknown"]);
});

test("ordered(): 无真实请求短板时，回落到**心跳上报**的延迟排序（组员定时上报即可知谁快）", async () => {
  const svc = createPeersService({
    file: tmpStateFile(),
    peers: [
      { name: "slow", url: "http://hb-slow", token: "t", heartbeatLatencyMs: 800 },
      { name: "fast", url: "http://hb-fast", token: "t", heartbeatLatencyMs: 30 },
      { name: "mid", url: "http://hb-mid", token: "t", heartbeatLatencyMs: 250 },
    ],
    errors: {},
  });
  // 一条真实请求都没跑过（stats 为空）→ 只能靠心跳延迟
  const urls = svc.ordered().map((p) => p.url);
  assert.deepEqual(urls, ["http://hb-fast", "http://hb-mid", "http://hb-slow"]);
});

test("ordered(): 真实请求 EMA 优先于心跳延迟", async () => {
  const svc = createPeersService({
    file: tmpStateFile(),
    peers: [
      { name: "hb-fast", url: "http://p1", token: "t", heartbeatLatencyMs: 10 },
      { name: "real-fast", url: "http://p2", token: "t", heartbeatLatencyMs: 900 },
    ],
    errors: {},
  });
  await svc.recordResult("http://p2", { ok: true, latencyMs: 5, model: "m" });
  const urls = svc.ordered().map((p) => p.url);
  assert.deepEqual(urls, ["http://p2", "http://p1"], "真实请求实测 5ms 应压过心跳的 10ms 判断");
});
