import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.js";
import { createRouter } from "../src/routes.js";
import { createUpstreamClient } from "../src/upstream.js";
import { appendCall, recentCalls, appendError, lastError } from "../src/logs.js";

const TOKEN = "a".repeat(64);

function tmpLogs() {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-routelogs-"));
  return {
    calls: join(dir, "calls.log"),
    errors: join(dir, "errors.log"),
  };
}

async function stubUpstream(handler) {
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv)));
  return srv;
}

async function boot({ upstreamHandler, logs }) {
  const up = await stubUpstream(upstreamHandler);
  const client = createUpstreamClient({
    baseUrl: `http://127.0.0.1:${up.address().port}`,
    retry: {},
  });
  const srv = startServer({ router: createRouter({ token: TOKEN, upstream: client, logs }) }, 0);
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

test("successful chat call is appended to the call log", async () => {
  const logs = tmpLogs();
  const app = await boot({
    logs: {
      appendCall: (e) => appendCall(e, { file: logs.calls }),
      appendError: (e) => appendError(e, { file: logs.errors }),
    },
    upstreamHandler: (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ model: "deepseek-v4-flash-free", messages: [] }),
    });
    assert.equal(res.status, 200);
    const calls = recentCalls(5, { file: logs.calls });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, "deepseek-v4-flash-free");
    assert.equal(calls[0].status, 200);
    assert.equal(calls[0].auto, false);
    assert.equal(calls[0].stream, false);
  } finally {
    await app.close();
  }
});

test("failed chat call appends an error log", async () => {
  const logs = tmpLogs();
  const app = await boot({
    logs: {
      appendCall: (e) => appendCall(e, { file: logs.calls }),
      appendError: (e) => appendError(e, { file: logs.errors }),
    },
    upstreamHandler: (req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "down" }));
    },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ model: "deepseek-v4-flash-free", messages: [] }),
    });
    assert.equal(res.status, 503);
    const err = lastError({ file: logs.errors });
    assert.equal(err.model, "deepseek-v4-flash-free");
    assert.equal(err.status, 503);
    const calls = recentCalls(5, { file: logs.calls });
    assert.equal(calls[0].status, 503);
  } finally {
    await app.close();
  }
});

test("no logs configured does not crash the router", async () => {
  const app = await boot({
    upstreamHandler: (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ model: "deepseek-v4-flash-free", messages: [] }),
    });
    assert.equal(res.status, 200);
  } finally {
    await app.close();
  }
});
