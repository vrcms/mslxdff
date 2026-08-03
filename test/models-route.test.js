import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer } from "../src/server.js";
import { createRouter } from "../src/routes.js";
import { createUpstreamClient } from "../src/upstream.js";
import { createModelsService } from "../src/models.js";

const TOKEN = "a".repeat(64);

const ALL_MODELS = [
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "ling-3.0-flash-free",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
  "laguna-s-2.1-free",
  "big-pickle",
  "claude-sonnet-4-5",
  "gpt-5",
];

async function boot({ models = ALL_MODELS, upstreamCalls = () => { } } = {}) {
  const up = await upstreamJsonModels(models, upstreamCalls);
  const client = createUpstreamClient({ baseUrl: `http://127.0.0.1:${up.address().port}`, retry: {} });
  const modelsService = createModelsService({ baseUrl: `http://127.0.0.1:${up.address().port}`, headers: client.headers });
  const srv = startServer({ router: createRouter({ token: TOKEN, upstream: client, models: modelsService }) }, 0);
  await srv.ready();
  return {
    port: srv.server.address().port,
    close: async () => {
      await srv.close();
      srv.server.closeAllConnections?.();
      await new Promise((r) => up.close(r));
      up.closeAllConnections?.();
    },
  };
}

async function upstreamJsonModels(models, calls) {
  const srv = createServer((req, res) => {
    calls();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: models.map((id) => ({ id, object: "model", created: 1, owned_by: "opencode" })),
      })
    );
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv)));
}

test("models route returns the 7 free models in OpenAI shape", async () => {
  const app = await boot({
    models: [
      "deepseek-v4-flash-free",
      "big-pickle",
      "claude-sonnet-4-5",
      "gemini-2.5-pro",
    ],
  });
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/models`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.object, "list");
    const ids = json.data.map((m) => m.id);
    assert.deepEqual([...ids].sort(), ["big-pickle", "deepseek-v4-flash-free"]);
  } finally {
    await app.close();
  }
});

test("401 without token", async () => {
  const app = await boot();
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/models`);
    assert.equal(res.status, 401);
  } finally {
    await app.close();
  }
});

test("models are cached for 10 minutes (single upstream fetch)", async () => {
  let upstreamFetches = 0;
  const app = await boot({ upstreamCalls: () => upstreamFetches++ });
  try {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`http://127.0.0.1:${app.port}/v1/models`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.status, 200);
    }
    assert.equal(upstreamFetches, 1);
  } finally {
    await app.close();
  }
});