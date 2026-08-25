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
  PREFERRED_MODEL,
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

test("rankModels puts the preferred model first when no errors", () => {
  const ids = [PREFERRED_MODEL, "deepseek-v4-flash-free", "mimo-v2.5-free"];
  const ranked = rankModels(ids, {});
  assert.equal(ranked[0], PREFERRED_MODEL);
  assert.deepEqual([...ranked].sort(), [...ids].sort(), "set preserved");
});

test("rankModels prefers the model that errored longest ago", () => {
  const ids = ["m-one-free", "m-two-free", "m-three-free"];
  const errors = {
    "m-one-free": 3000,
    "m-two-free": 1000,
    "m-three-free": 2000,
  };
  // m-two errored at 1000 (longest ago) -> first; m-three 2000; m-one 3000 last
  assert.deepEqual(rankModels(ids, errors), ["m-two-free", "m-three-free", "m-one-free"]);
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
  // 显式指定模型严格优先：即使冷却也保持第一（原设计：A deepseek 失败 → B/D deepseek 并发 → 都失败才 fallback）
  assert.equal(list[0], "deepseek-v4-flash-free");
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
  const { flushStateSync } = await import("../src/state.js");
  flushStateSync(file);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(saved.modelErrors["deepseek-v4-flash-free"], { status: "error", at: now, code: null, slow: false });
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

test("recordError classifies 429 and rate-limit messages as limit", async () => {
  const auto = createAutoSelector({ loadCandidates: async () => ["m-free"], errors: {}, now: () => 10_000 });
  await auto.recordError("m-free", { status: 429 });
  assert.deepEqual(auto.errors()["m-free"], { status: "limit", at: 10_000, code: 429, slow: false });

  await auto.recordError("m-free", { message: "FreeUsageLimitError: Rate limit exceeded" });
  assert.equal(auto.errors()["m-free"].status, "limit");
});

test("recordError classifies other http codes and network errors as error", async () => {
  const auto = createAutoSelector({ loadCandidates: async () => ["m-free"], errors: {}, now: () => 20_000 });
  await auto.recordError("m-free", { status: 503 });
  assert.deepEqual(auto.errors()["m-free"], { status: "error", at: 20_000, code: 503, slow: false });

  await auto.recordError("m-free", { message: "upstream timed out after 30000ms" });
  assert.equal(auto.errors()["m-free"].status, "error");
});

test("recordOk resets a model to normal", async () => {
  const auto = createAutoSelector({ loadCandidates: async () => ["m-free"], errors: {}, now: () => 30_000 });
  await auto.recordError("m-free", { status: 429 });
  await auto.recordOk("m-free");
  assert.deepEqual(auto.errors()["m-free"], { status: "normal", at: 30_000, code: 200, slow: false });
});

test("rankModels still ranks legacy numeric entries", () => {
  const ids = ["a-free", "b-free"];
  const ranked = rankModels(ids, { "a-free": 5000, "b-free": 1000 });
  assert.deepEqual(ranked, ["b-free", "a-free"], "oldest error first");
});

test("cooldown works with both legacy numeric and object entries", () => {
  const now = 100_000;
  const ids = ["a-free", "b-free", "c-free"];
  const errors = {
    "a-free": now - 5_000,                    // legacy number, cooling
    "b-free": { status: "limit", at: now - 500 }, // object, cooling
    "c-free": { status: "error", at: now - 120_000 }, // object, elapsed
  };
  const ranked = rankModels(ids, errors, { now, cooldownMs: 60_000 });
  assert.equal(ranked[ranked.length - 1], "b-free", "most recent event last");
  assert.equal(ranked[0], "c-free", "elapsed cooldown first");
});

test("slow models use the longer slow cooldown and rank last", () => {
  const now = 200_000;
  const ids = ["a-free", "b-free", "c-free"];
  // a-free is slow (flagged) recently — should stay parked out of rotation
  const errors = {
    "a-free": { status: "error", at: now - 10_000, code: 200, slow: true },
    "b-free": { status: "error", at: now - 120_000, code: 200, slow: false },
    "c-free": { status: "normal", at: now - 120_000, code: 200, slow: false },
  };
  const ranked = rankModels(ids, errors, { now, cooldownMs: 60_000, slowCooldownMs: 5 * 60_000 });
  assert.equal(ranked[0], "b-free", "normal cooldown elapsed, healthy first");
  assert.equal(ranked[ranked.length - 1], "a-free", "slow model parked last");
});

test("recordError with slow flag persists slow and uses long cooldown", async () => {
  const auto = createAutoSelector({
    loadCandidates: async () => ["m-free", "fast-free"],
    errors: { "fast-free": { status: "normal", at: 1000, code: 200 } },
    now: () => 50_000,
  });
  await auto.recordError("m-free", { status: 200, slow: true });
  assert.equal(auto.errors()["m-free"].status, "error");
  assert.equal(auto.errors()["m-free"].slow, true);
  assert.equal(auto.errors()["m-free"].code, 200);

  // slow model is parked behind the fast one during the slow window
  const ranked = await auto.candidates();
  assert.equal(ranked[0], "fast-free");
  assert.equal(ranked[1], "m-free");
});

test("http 429 records limit status, later success resets to normal", async () => {
  let mode = "limit";
  const auto = createAutoSelector({
    loadCandidates: async () => ["deepseek-v4-flash-free", "mimo-v2.5-free"],
    errors: {},
    cooldownMs: 0,
  });
  const app = await boot({
    auto,
    upstreamHandler: (req, res, body) => {
      const model = JSON.parse(body).model;
      if (mode === "limit" && model === "deepseek-v4-flash-free") {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Rate limit exceeded" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model, ok: true }));
    },
  });
  try {
    const res = await postChat(app, { model: "deepseek-v4-flash-free", messages: [] });
    assert.equal(res.status, 200);
    const st = auto.errors()["deepseek-v4-flash-free"];
    assert.equal(st.status, "limit");
    assert.equal(st.code, 429);
    assert.ok(st.at > 0);

    mode = "ok";
    const res2 = await postChat(app, { model: "deepseek-v4-flash-free", messages: [] });
    assert.equal(res2.status, 200);
    const st2 = auto.errors()["deepseek-v4-flash-free"];
    assert.equal(st2.status, "normal");
    assert.equal(st2.code, 200);
    assert.ok(st2.at >= st.at, "success timestamp must be newer or equal");
  } finally {
    await app.close();
  }
});

test("/v1/models/status requires auth and reports recorded statuses", async () => {
  const auto = createAutoSelector({ loadCandidates: async () => [], errors: {}, now: () => 777_000 });
  await auto.recordError("m1-free", { status: 429 });
  await auto.recordError("m2-free", { status: 503 });
  await auto.recordOk("m3-free");
  const app = await boot({ auto, upstreamHandler: (req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); } });
  try {
    const unauth = await fetch(`http://127.0.0.1:${app.port}/v1/models/status`);
    assert.equal(unauth.status, 401);

    const res = await fetch(`http://127.0.0.1:${app.port}/v1/models/status`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.object, "list");
    const byId = Object.fromEntries(json.data.map((m) => [m.id, m]));
    assert.equal(byId["m1-free"].status, "limit");
    assert.equal(byId["m1-free"].at, 777_000);
    assert.equal(byId["m1-free"].code, 429);
    assert.equal(byId["m2-free"].status, "error");
    assert.equal(byId["m3-free"].status, "normal");
  } finally {
    await app.close();
  }
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

test("empty model resolves to auto: preferred model forwarded, other models not touched", async () => {
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
    assert.deepEqual(seen, [PREFERRED_MODEL]);
  } finally {
    await app.close();
  }
});

test("auto: first model 400, falls back to next candidate, records error", async () => {
  const seen = [];
  const errors = {};
  const nextAfterPreferred = DEFAULT_AUTO_MODELS.filter((m) => m !== PREFERRED_MODEL)[0];
  const auto = createAutoSelector({ loadCandidates: async () => DEFAULT_AUTO_MODELS, errors });
  const app = await boot({
    auto,
    upstreamHandler: (req, res, body) => {
      const model = JSON.parse(body).model;
      seen.push(model);
      if (model === PREFERRED_MODEL) {
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
    assert.equal(json.model, nextAfterPreferred);
    assert.ok(seen.includes(PREFERRED_MODEL));
    assert.ok(seen.includes(nextAfterPreferred));
    assert.ok(auto.errors()[PREFERRED_MODEL], "preferred model error must be recorded");
    assert.equal(auto.errors()[nextAfterPreferred]?.status, "normal", "success resets the model to normal");
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
  const auto = createAutoSelector({ loadCandidates: async () => ["big-pickle", "deepseek-v4-flash-free", "mimo-v2.5-free"], errors: {}, latencies: {}, cooldownMs: 60_000, file: tmpStateFile() });
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
    // with no latency history, fallback respects original order
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
    // 显式模型严格语义：冷却不跳过，仍先试 deepseek（原设计）
    assert.deepEqual(seen, ["deepseek-v4-flash-free"], "explicit model always tried first even when cooling");
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

// ---- 常用模型勾选集（modelPicks）：auto 只在勾选内择优 ----

test("candidates restricts pool to picked models when picks non-empty", async () => {
  const auto = createAutoSelector({
    loadCandidates: async () => ["a-free", "b-free", "c-free"],
    errors: {},
    now: () => 1000,
    loadPicks: () => ["a-free", "c-free"],
  });
  const list = await auto.candidates();
  assert.deepEqual(list, ["a-free", "c-free"]);
});

test("candidates uses full pool when picks empty", async () => {
  const auto = createAutoSelector({
    loadCandidates: async () => ["a-free", "b-free", "c-free"],
    errors: {},
    now: () => 1000,
    loadPicks: () => [],
  });
  const list = await auto.candidates();
  assert.deepEqual(list, ["a-free", "b-free", "c-free"]);
});

test("candidates falls back to full pool when none of the picks exist upstream", async () => {
  const auto = createAutoSelector({
    loadCandidates: async () => ["a-free", "b-free"],
    errors: {},
    now: () => 1000,
    loadPicks: () => ["ghost-free", "dropped-free"],
  });
  const list = await auto.candidates();
  assert.deepEqual(list, ["a-free", "b-free"], "all-missing picks must not starve auto");
});

test("candidatesFor auto-picks the requested model (persists via persistPicks)", async () => {
  const persisted = [];
  const auto = createAutoSelector({
    loadCandidates: async () => ["a-free", "b-free"],
    errors: {},
    now: () => 1000,
    loadPicks: () => [],
    persistPicks: async (picks) => { persisted.push([...picks]); return picks; },
  });
  const list = await auto.candidatesFor("a-free");
  assert.equal(list[0], "a-free");
  assert.deepEqual(persisted, [["a-free"]], "explicit request auto-adds to picks");
});

test("candidatesFor does not auto-pick a non-existent model id", async () => {
  const persisted = [];
  const auto = createAutoSelector({
    loadCandidates: async () => ["a-free", "b-free"],
    errors: {},
    now: () => 1000,
    loadPicks: () => [],
    persistPicks: async (picks) => { persisted.push([...picks]); return picks; },
  });
  const list = await auto.candidatesFor("ghost-free");
  assert.equal(list[0], "ghost-free", "explicit request still tried first");
  assert.equal(persisted.length, 0, "garbage id must not pollute picks");
});

test("candidatesFor does not re-persist already-picked model", async () => {
  let persistCalls = 0;
  const auto = createAutoSelector({
    loadCandidates: async () => ["a-free", "b-free"],
    errors: {},
    now: () => 1000,
    loadPicks: () => ["a-free", "b-free"],
    persistPicks: async (picks) => { persistCalls++; return picks; },
  });
  await auto.candidatesFor("a-free");
  await auto.candidatesFor("a-free");
  assert.equal(persistCalls, 0, "already-picked model should not rewrite picks");
});
