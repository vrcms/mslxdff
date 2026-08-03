import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createUpstreamClient } from "../src/upstream.js";

function stubServer(handler) {
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

function urlOf(srv) {
  return `http://127.0.0.1:${srv.address().port}`;
}

async function closeSrv(srv) {
  await new Promise((r) => srv.close(r));
  srv.closeAllConnections?.();
}

test("client posts to upstream with required headers", async () => {
  let seen;
  const srv = await stubServer((req, res, body) => {
    seen = { headers: req.headers, body };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const client = createUpstreamClient({ baseUrl: urlOf(srv) });
    const res = await client.chat({ model: "deepseek-v4-flash-free", messages: [] }, false);
    assert.equal(res.status, 200);
    assert.equal(seen.headers["x-opencode-client"], "desktop");
    assert.equal(seen.headers["authorization"], "Bearer public");
    assert.equal(seen.headers["accept"], "text/event-stream");
    assert.deepEqual(JSON.parse(seen.body), { model: "deepseek-v4-flash-free", messages: [] });
  } finally {
    await closeSrv(srv);
  }
});

test("client honors UPSTREAM_AUTH_TOKEN override", async () => {
  let seen;
  const srv = await stubServer((req, res, body) => {
    seen = req.headers;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  try {
    const client = createUpstreamClient({ baseUrl: urlOf(srv), authToken: "sekret" });
    await client.chat({}, false);
    assert.equal(seen.authorization, "Bearer sekret");
  } finally {
    await closeSrv(srv);
  }
});

test("client retries 429 with backoff up to the configured attempts", async () => {
  let calls = 0;
  const srv = await stubServer((req, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(429);
      res.end("slow down");
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    }
  });
  try {
    const client = createUpstreamClient({ baseUrl: urlOf(srv), retry: { 429: { attempts: 1, delayMs: 1 } } });
    const res = await client.chat({}, false);
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
  } finally {
    await closeSrv(srv);
  }
});

test("client does not retry 400", async () => {
  let calls = 0;
  const srv = await stubServer((req, res) => {
    calls++;
    res.writeHead(400);
    res.end("bad");
  });
  try {
    const client = createUpstreamClient({ baseUrl: urlOf(srv), retry: { 429: { attempts: 3, delayMs: 1 } } });
    const res = await client.chat({}, false);
    assert.equal(res.status, 400);
    assert.equal(calls, 1);
  } finally {
    await closeSrv(srv);
  }
});

test("connect timeout aborts a slow upstream", async () => {
  const srv = await stubServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    }, 500);
  });
  try {
    const client = createUpstreamClient({ baseUrl: urlOf(srv), connectTimeoutMs: 50, retry: {} });
    await assert.rejects(() => client.chat({}, false), /timed out|abort/i);
  } finally {
    await closeSrv(srv);
  }
});