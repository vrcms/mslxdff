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

test("codex caller (UA codex_*) gets top-level models:[] alongside data", async () => {
  const app = await boot({ models: ["big-pickle"] });
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/models`, {
      headers: { Authorization: `Bearer ${TOKEN}`, "user-agent": "codex_cli_rs/0.153.0 (Windows 11; x86_64)" },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(Array.isArray(json.data), "data[] intact for OpenAI consumers");
    assert.deepEqual(json.models, [], "codex needs top-level models array (empty by design)");
  } finally {
    await app.close();
  }
});

test("codex caller (?client_version=) gets models:[]", async () => {
  const app = await boot({ models: ["big-pickle"] });
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/models?client_version=0.153.0`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const json = await res.json();
    assert.deepEqual(json.models, []);
  } finally {
    await app.close();
  }
});

test("non-codex client keeps byte-identical shape (no models key)", async () => {
  const app = await boot({ models: ["big-pickle"] });
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/models`, {
      headers: { Authorization: `Bearer ${TOKEN}`, "user-agent": "OpenAI/Python 1.99.0" },
    });
    const json = await res.json();
    assert.ok(Array.isArray(json.data));
    assert.ok(!("models" in json));
  } finally {
    await app.close();
  }
});
test("?raw=1 完全不富化：无 capabilities、也不补 L4 兜底窗口（ADR-0054 承诺锁）", async () => {
  const app = await boot({ models: ["big-pickle"] });
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/models?raw=1`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const json = await res.json();
    const m = json.data.find((x) => x.id === "big-pickle");
    assert.ok(m, "raw=1 仍返回条目");
    assert.equal("capabilities" in m, false, "raw=1 不富化能力（regex 只认 (^|&)raw=1(&|$)，误写成 /raw=1/ 子串会被此断言放过的路径由本用例反向锁）");
    assert.equal("context_length" in m, false, "raw=1 不补 L4（stub 条目未自报窗口，富化链必须整体不跑）");
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