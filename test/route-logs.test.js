import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.js";
import { createRouter } from "../src/routes.js";
import { summarizePrompt, PROMPT_MAX_LEN } from "../src/routes.js";
import { createPeersService } from "../src/peers.js";
import { createUpstreamClient } from "../src/upstream.js";
import { appendCall, recentCalls, appendError, lastError, appendEvent, recentEvents } from "../src/logs.js";

const TOKEN = "a".repeat(64);

test("summarizePrompt picks the last message text", () => {
  assert.equal(summarizePrompt({ messages: [{ role: "user", content: "hi" }] }), "hi");
  assert.equal(
    summarizePrompt({ messages: [{ role: "user", content: "" }, { role: "assistant", content: "  a\nb  c " }] }),
    "a b c"
  );
});

test("summarizePrompt flattens multi-modal content parts", () => {
  assert.equal(
    summarizePrompt({ messages: [{ role: "user", content: [{ type: "image_url" }, { type: "text", text: "what is this" }] }] }),
    "what is this"
  );
});

test("summarizePrompt truncates long prompts", () => {
  const long = "x".repeat(PROMPT_MAX_LEN * 2);
  const out = summarizePrompt({ messages: [{ role: "user", content: long }] });
  assert.ok(out.length <= PROMPT_MAX_LEN + 1, "truncated with ellipsis");
  assert.ok(out.endsWith("…"));
});

test("summarizePrompt handles missing bodies", () => {
  assert.equal(summarizePrompt(undefined), "");
  assert.equal(summarizePrompt({}), "");
  assert.equal(summarizePrompt({ messages: [] }), "");
});

function tmpLogs() {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-routelogs-"));
  return {
    calls: join(dir, "calls.log"),
    errors: join(dir, "errors.log"),
    events: join(dir, "events.log"),
  };
}

function logsAdapter(logs) {
  return {
    appendCall: (e) => appendCall(e, { file: logs.calls }),
    appendError: (e) => appendError(e, { file: logs.errors }),
    appendEvent: (e) => appendEvent(e, { file: logs.events }),
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

test("event stream records request and result for a local success", async () => {
  const logs = tmpLogs();
  const app = await boot({
    logs: logsAdapter(logs),
    upstreamHandler: (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "x-mslxdff-hops": "2" },
      body: JSON.stringify({ model: "deepseek-v4-flash-free", messages: [{ role: "user", content: "hello world" }] }),
    });
    assert.equal(res.status, 200);
    const events = recentEvents(10, { file: logs.events });
    const types = events.map((e) => e.type);
    assert.deepEqual(types, ["request", "result"]);
    assert.equal(events[0].model, "deepseek-v4-flash-free");
    assert.equal(events[0].hops, 2);
    assert.equal(events[0].auto, false);
    assert.equal(events[0].prompt, "hello world");
    assert.ok(events[0].ip);
    assert.equal(events[1].status, 200);
    assert.equal(events[1].via, "local");
    assert.ok(events[1].durationMs >= 0);
  } finally {
    await app.close();
  }
});

test("event stream shows upstream error then peer forward chain", async () => {
  const logs = tmpLogs();
  const peerSrv = createServer((req, res) => {
    const url = (req.url || "").split("?")[0];
    if (req.method === "GET" && url === "/v1/models/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "peer-model-free", status: "normal" }] }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ from: "peer", model: JSON.parse(body).model }));
    });
  });
  await new Promise((r) => peerSrv.listen(0, "127.0.0.1", () => r()));
  const peers = createPeersService({
    peers: [{ name: "p", url: `http://127.0.0.1:${peerSrv.address().port}`, token: "t" }],
    errors: {},
  });
  const up = await stubUpstream((req, res) => {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Rate limit exceeded" }));
  });
  const client = createUpstreamClient({ baseUrl: `http://127.0.0.1:${up.address().port}`, retry: {} });
  const srv = startServer({ router: createRouter({ token: TOKEN, upstream: client, logs: logsAdapter(logs), peers }) }, 0);
  await srv.ready();
  const port = srv.server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ model: "deepseek-v4-flash-free", messages: [] }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.from, "peer");
    const events = recentEvents(10, { file: logs.events });
    const types = events.map((e) => e.type);
    assert.ok(types.includes("request"));
    assert.ok(types.includes("upstream-error"));
    assert.ok(types.includes("peer-health"));
    assert.ok(types.includes("peer-forward"));
    assert.ok(types.includes("result"));
    const ue = events.find((e) => e.type === "upstream-error");
    assert.equal(ue.status, 429);
    assert.equal(ue.model, "deepseek-v4-flash-free");
    const pf = events.find((e) => e.type === "peer-forward");
    assert.equal(pf.model, "peer-model-free");
    assert.equal(pf.peer, `http://127.0.0.1:${peerSrv.address().port}`);
    const r = events.find((e) => e.type === "result");
    assert.equal(r.via, "peer");
    assert.equal(r.status, 200);
  } finally {
    await srv.close();
    srv.server.closeAllConnections?.();
    await new Promise((r) => peerSrv.close(r));
    peerSrv.closeAllConnections?.();
    await new Promise((r) => up.close(r));
    up.closeAllConnections?.();
  }
});

test("event stream records final failure when everything fails", async () => {
  const logs = tmpLogs();
  const app = await boot({
    logs: logsAdapter(logs),
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
    const events = recentEvents(10, { file: logs.events });
    const result = events.find((e) => e.type === "result");
    assert.ok(result, "a final result event is recorded");
    assert.equal(result.status, 503);
    assert.ok(events.some((e) => e.type === "upstream-error" && e.status === 503));
  } finally {
    await app.close();
  }
});
