import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.js";
import { createRouter } from "../src/routes.js";
import { createUpstreamClient } from "../src/upstream.js";
import {
  createAutoSelector,
  rankModels,
  isAutoModel,
  DEFAULT_AUTO_MODELS,
} from "../src/auto.js";
const TOKEN = "a".repeat(64);

function tmpStateFile() {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-auto-"));
  return join(dir, "state.json");
}

test("isAutoModel treats empty and auto as auto, others explicit", () => {
  assert.equal(isAutoModel(""), true);
  assert.equal(isAutoModel(undefined), true);
  assert.equal(isAutoModel("auto"), true);
  assert.equal(isAutoModel("oc/auto"), false); // oc/auto is an explicit model id
  assert.equal(isAutoModel("deepseek-v4-flash-free"), false);
});

test("rankModels puts deepseek first when no errors", () => {
  const ids = ["big-pickle", "deepseek-v4-flash-free", "mimo-v2.5-free"];
  const ranked = rankModels(ids, {});
  assert.equal(ranked[0], "deepseek-v4-flash-free");
  assert.deepEqual([...ranked].sort(), [...ids].sort(), "set preserved");
});

test("rankModels prefers the model that errored longest ago", () => {
  const ids = ["deepseek-v4-flash-free", "mimo-v2.5-free", "big-pickle"];
  const errors = {
    "deepseek-v4-flash-free": 3000,
    "mimo-v2.5-free": 1000,
    "big-pickle": 2000,
  };
  // mimo errored at 1000 (longest ago) -> first; big-pickle 2000; deepseek 3000 last
  assert.deepEqual(rankModels(ids, errors), ["mimo-v2.5-free", "big-pickle", "deepseek-v4-flash-free"]);
});

test("a recently-errored deepseek yields to never-errored others", () => {
  const ids = ["deepseek-v4-flash-free", "mimo-v2.5-free", "big-pickle"];
  const errors = { "deepseek-v4-flash-free": Date.now() };
  // deepseek now errored; others have err 0 -> others first, deepseek last
  const ranked = rankModels(ids, errors);
  assert.notEqual(ranked[0], "deepseek-v4-flash-free");
  assert.equal(ranked[ranked.length - 1], "deepseek-v4-flash-free");
});

test("rankModels moves cooldown models to the back", () => {
  const ids = ["deepseek-v4-flash-free", "mimo-v2.5-free", "big-pickle"];
  const errors = { "mimo-v2.5-free": Date.now() - 5000 };
  const ranked = rankModels(ids, errors, { now: Date.now(), cooldownMs: 60_000 });
  assert.equal(ranked[ranked.length - 1], "mimo-v2.5-free");
});

test("rankModels ignores cooldown when window has elapsed", () => {
  const now = 200_000;
  const ids = ["deepseek-v4-flash-free", "mimo-v2.5-free", "big-pickle"];
  const errors = {
    "deepseek-v4-flash-free": now - 120_000, // cooldown elapsed
    "mimo-v2.5-free": now - 5_000,           // still cooling
  };
  const ranked = rankModels(ids, errors, { now, cooldownMs: 60_000 });
  assert.equal(ranked[ranked.length - 1], "mimo-v2.5-free");
  assert.equal(ranked[1], "deepseek-v4-flash-free", "elapsed-cooldown model ranks by error time, not forced last");
});

test("candidatesFor returns requested model first when healthy", async () => {
  const auto = createAutoSelector({
    loadCandidates: async () => ["mimo-v2.5-free", "deepseek-v4-flash-free", "big-pickle"],
    errors: {},
    cooldownMs: 60_000,
    now: () => 1000,
  });
  const list = await auto.candidatesFor("deepseek-v4-flash-free");
  assert.equal(list[0], "deepseek-v4-flash-free");
});

test("candidatesFor pushes a cooldown model to the back", async () => {
  const auto = createAutoSelector({
    loadCandidates: async () => ["mimo-v2.5-free", "deepseek-v4-flash-free", "big-pickle"],
    errors: { "deepseek-v4-flash-free": 900 },
    cooldownMs: 60_000,
    now: () => 1000,
  });
  const list = await auto.candidatesFor("deepseek-v4-flash-free");
  assert.equal(list[list.length - 1], "deepseek-v4-flash-free");
  assert.ok(list.includes("mimo-v2.5-free"));
});

test("createAutoSelector falls back to DEFAULT_AUTO_MODELS when no candidates load", async () => {
  const auto = createAutoSelector({ loadCandidates: async () => null, errors: {} });
  const list = await auto.candidates();
  assert.deepEqual(list, DEFAULT_AUTO_MODELS);
});

test("recordError persists modelErrors to the state file", async () => {
  const file = tmpStateFile();
  const auto = createAutoSelector({ loadCandidates: async () => ["deepseek-v4-flash-free"], errors: {}, file });
  const now = 1234567890;
  const ts = now + 1;
  // record with an explicit now
  const auto2 = createAutoSelector({
    loadCandidates: async () => ["deepseek-v4-flash-free"],
    errors: {},
    file,
    now: () => now,
  });
  await auto2.recordError("deepseek-v4-flash-free");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.modelErrors["deepseek-v4-flash-free"], now);
  assert.deepEqual(auto.errors(), {});
});

test("recordError updates in-memory ranking", async () => {
  const auto = createAutoSelector({
    loadCandidates: async () => ["deepseek-v4-flash-free", "mimo-v2.5-free"],
    errors: {},
    now: () => 5000,
  });
  await auto.recordError("deepseek-v4-flash-free");
  const list = await auto.candidates();
  assert.equal(list[0], "mimo-v2.5-free");
  assert.equal(list[1], "deepseek-v4-flash-free");
});

async function stubUpstream(handler) {
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv)));
}

async function boot({ upstreamHandler, auto }) {
  const up = await stubUpstream(upstreamHandler);
  const client = createUpstreamClient({
    baseUrl: `http://127.0.0.1:${up.address().port}`,
    retry: {},
  });
  const srv = startServer(
    { router: createRouter({ token: TOKEN, upstream: client, auto }) },
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

async function postChat(app, body) {
  const res = await fetch(`http://127.0.0.1:${app.port}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return res;
}

test("empty model resolves to auto: deepseek forwarded, other models not touched", async () => {
  const seen = [];
  const auto = createAutoSelector({ loadCandidates: async () => DEFAULT_AUTO_MODELS, errors: {} });
  const app = await boot({
    auto,
    upstreamHandler: (req, res, body) => {
      seen.push(JSON.parse(body).model);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: seen[seen.length - 1], ok: true }));
    },
  });
  try {
    const res = await postChat(app, { messages: [] });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["deepseek-v4-flash-free"]);
  } finally {
    await app.close();
  }
});

test("auto: first model 400, falls back to next candidate, records error", async () => {
  const seen = [];
  const errors = {};
  const auto = createAutoSelector({ loadCandidates: async () => DEFAULT_AUTO_MODELS, errors });
  const app = await boot({
    auto,
    upstreamHandler: (req, res, body) => {
      const model = JSON.parse(body).model;
      seen.push(model);
      if (model === "deepseek-v4-flash-free") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "nope" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model, ok: true }));
    },
  });
  try {
    const res = await postChat(app, { messages: [] });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.model, "mimo-v2.5-free");
    assert.ok(seen.includes("deepseek-v4-flash-free"));
    assert.ok(seen.includes("mimo-v2.5-free"));
    assert.ok(auto.errors()["deepseek-v4-flash-free"], "deepseek error must be recorded");
    assert.equal(auto.errors()["mimo-v2.5-free"], undefined, "success must not be recorded as error");
  } finally {
    await app.close();
  }
});

test("auto: all candidates fail, last upstream error relayed and all recorded", async () => {
  const seen = [];
  const auto = createAutoSelector({ loadCandidates: async () => ["a-free", "b-free"], errors: {} });
  const app = await boot({
    auto,
    upstreamHandler: (req, res, body) => {
      seen.push(JSON.parse(body).model);
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "down" }));
    },
  });
  try {
    const res = await postChat(app, { model: "auto", messages: [] });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "down" });
    assert.deepEqual(seen, ["a-free", "b-free"]);
    assert.ok(auto.errors()["a-free"]);
    assert.ok(auto.errors()["b-free"]);
  } finally {
    await app.close();
  }
});

test("explicit model falls back on error and records it", async () => {
  const seen = [];
  const auto = createAutoSelector({ loadCandidates: async () => ["deepseek-v4-flash-free", "mimo-v2.5-free"], errors: {}, cooldownMs: 60_000 });
  const app = await boot({
    auto,
    upstreamHandler: (req, res, body) => {
      const model = JSON.parse(body).model;
      seen.push(model);
      if (model === "deepseek-v4-flash-free") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model, ok: true }));
    },
  });
  try {
    const res = await postChat(app, { model: "deepseek-v4-flash-free", messages: [] });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.model, "mimo-v2.5-free");
    assert.deepEqual(seen, ["deepseek-v4-flash-free", "mimo-v2.5-free"], "falls back within the same request");
    assert.ok(auto.errors()["deepseek-v4-flash-free"]);
  } finally {
    await app.close();
  }
});

test("explicit model that errors falls back to the next candidate", async () => {
  const seen = [];
  const auto = createAutoSelector({ loadCandidates: async () => ["big-pickle", "deepseek-v4-flash-free", "mimo-v2.5-free"], errors: {}, cooldownMs: 60_000 });
  const app = await boot({
    auto,
    upstreamHandler: (req, res, body) => {
      const model = JSON.parse(body).model;
      seen.push(model);
      if (model === "deepseek-v4-flash-free") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model, ok: true }));
    },
  });
  try {
    const res = await postChat(app, { model: "deepseek-v4-flash-free", messages: [] });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.model, "big-pickle");
    assert.deepEqual(seen, ["deepseek-v4-flash-free", "big-pickle"]);
  } finally {
    await app.close();
  }
});

test("explicit model within cooldown is skipped first (backup used directly)", async () => {
  const seen = [];
  const now = () => 1000;
  const auto = createAutoSelector({
    loadCandidates: async () => ["deepseek-v4-flash-free", "mimo-v2.5-free"],
    errors: { "deepseek-v4-flash-free": 995 }, // errored 5ms ago, within 60s cooldown
    now,
    cooldownMs: 60_000,
  });
  const app = await boot({
    auto,
    upstreamHandler: (req, res, body) => {
      seen.push(JSON.parse(body).model);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: seen[seen.length - 1], ok: true }));
    },
  });
  try {
    const res = await postChat(app, { model: "deepseek-v4-flash-free", messages: [] });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mimo-v2.5-free"], "cooldown model skipped first");
  } finally {
    await app.close();
  }
});

test("explicit model outside cooldown is tried first again", async () => {
  const seen = [];
  const now = () => 120_000;
  const auto = createAutoSelector({
    loadCandidates: async () => ["deepseek-v4-flash-free", "mimo-v2.5-free"],
    errors: { "deepseek-v4-flash-free": 10_000 }, // errored 110s ago, beyond 60s cooldown
    now,
    cooldownMs: 60_000,
  });
  const app = await boot({
    auto,
    upstreamHandler: (req, res, body) => {
      seen.push(JSON.parse(body).model);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: seen[seen.length - 1], ok: true }));
    },
  });
  try {
    const res = await postChat(app, { model: "deepseek-v4-flash-free", messages: [] });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["deepseek-v4-flash-free"], "model retried after cooldown");
  } finally {
    await app.close();
  }
});

test("all explicit candidates fail, last upstream error relayed", async () => {
  const seen = [];
  const auto = createAutoSelector({ loadCandidates: async () => ["deepseek-v4-flash-free", "mimo-v2.5-free"], errors: {}, cooldownMs: 60_000 });
  const app = await boot({
    auto,
    upstreamHandler: (req, res, body) => {
      seen.push(JSON.parse(body).model);
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "down" }));
    },
  });
  try {
    const res = await postChat(app, { model: "deepseek-v4-flash-free", messages: [] });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "down" });
    assert.deepEqual(seen, ["deepseek-v4-flash-free", "mimo-v2.5-free"]);
    assert.ok(auto.errors()["deepseek-v4-flash-free"]);
    assert.ok(auto.errors()["mimo-v2.5-free"]);
  } finally {
    await app.close();
  }
});
