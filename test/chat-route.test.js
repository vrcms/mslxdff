import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer } from "../src/server.js";
import { createRouter } from "../src/routes.js";
import { createUpstreamClient } from "../src/upstream.js";

const TOKEN = "a".repeat(64);

function stubUpstream(handler) {
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

async function boot({ upstreamHandler, token = TOKEN } = {}) {
  const up = await stubUpstream(upstreamHandler);
  const client = createUpstreamClient({
    baseUrl: `http://127.0.0.1:${up.address().port}`,
    retry: {},
  });
  const srv = startServer(
    { router: createRouter({ token, upstream: client }) },
    0
  );
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

test("401 without token, with WWW-Authenticate", async () => {
  const app = await boot({ upstreamHandler: (req, res) => res.end("{}") });
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "deepseek-v4-flash-free", messages: [] }),
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("www-authenticate"), "Bearer");
  } finally {
    await app.close();
  }
});

test("401 on wrong token", async () => {
  const app = await boot({ upstreamHandler: (req, res) => res.end("{}") });
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer b".repeat(64) },
      body: JSON.stringify({ model: "deepseek-v4-flash-free", messages: [] }),
    });
    assert.equal(res.status, 401);
  } finally {
    await app.close();
  }
});

test("non-streaming response passes JSON through", async () => {
  const up = {
    ok: true,
    id: "router-1",
    model: "deepseek-v4-flash-free",
    usage: { total_tokens: 11 },
    cost: "0",
  };
  const app = await boot({
    upstreamHandler: (req, res, body) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(up));
    },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ model: "deepseek-v4-flash-free", messages: [] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), up);
  } finally {
    await app.close();
  }
});

test("reasoning placeholder is injected before upstream send", async () => {
  let seenBody;
  const app = await boot({
    upstreamHandler: (req, res, body) => {
      seenBody = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    },
  });
  try {
    await fetch(`http://127.0.0.1:${app.port}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        model: "deepseek-v4-flash-free",
        messages: [{ role: "assistant", content: "hi" }],
      }),
    });
    assert.equal(seenBody.messages[0].reasoning_content, " ");
  } finally {
    await app.close();
  }
});

test("oc/ prefix is stripped before upstream send", async () => {
  let seenModel;
  const app = await boot({
    upstreamHandler: (req, res, body) => {
      seenModel = JSON.parse(body).model;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    },
  });
  try {
    await fetch(`http://127.0.0.1:${app.port}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ model: "oc/big-pickle", messages: [] }),
    });
    assert.equal(seenModel, "big-pickle");
  } finally {
    await app.close();
  }
});

test("streaming relays SSE chunks verbatim including [DONE]", async () => {
  const chunks = [
    'data: {"id":"x","choices":[{"delta":{"content":"hi"}}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const app = await boot({
    upstreamHandler: (req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const c of chunks) res.write(c);
      res.end();
    },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ model: "deepseek-v4-flash-free", messages: [], stream: true }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const text = await res.text();
    assert.ok(text.includes("data: [DONE]"));
    assert.ok(text.includes("hi"));
  } finally {
    await app.close();
  }
});

test("upstream error status is forwarded", async () => {
  const app = await boot({
    upstreamHandler: (req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "bad request" }));
    },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ model: "deepseek-v4-flash-free", messages: [] }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "bad request" });
  } finally {
    await app.close();
  }
});