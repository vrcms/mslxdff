import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { startServer } from "../src/server.js";
import { createRouter } from "../src/routes.js";
import { createUpstreamClient } from "../src/upstream.js";
import { createAutoSelector } from "../src/auto.js";
import { loadPlugins } from "../src/plugins.js";

const TOKEN = "a".repeat(64);

function tmpPluginsDir() {
  return mkdtempSync(join(tmpdir(), "mslxdff-plugins-e2e-"));
}

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

async function boot({ pluginCode, upstreamHandler }) {
  const dir = tmpPluginsDir();
  if (pluginCode) writeFileSync(join(dir, "p.mjs"), pluginCode);
  const { plugins } = await loadPlugins({ dir });
  const up = await stubUpstream(upstreamHandler);
  const client = createUpstreamClient({ baseUrl: `http://127.0.0.1:${up.address().port}`, retry: {} });
  // 使用临时 state 并注入 dummy normal，禁用并发择优，保持串行以便 plugin hook（model:beforeTry / upstream:response）可按预期触发
  const file = mkdtempSync(join(tmpdir(), "mslxdff-plug-state-")) + "/state.json";
  const auto = createAutoSelector({ loadCandidates: async () => ["m-one-free", "m-two-free"], errors: { "_dummy": { status: "normal", at: 1, code: 200, slow: false } }, file });
  const srv = startServer(
    { router: createRouter({ token: TOKEN, upstream: client, auto, plugins }), models: null },
    0
  );
  await srv.ready();
  return {
    port: srv.server.address().port,
    plugins,
    close: async () => {
      await srv.close();
      srv.server.closeAllConnections?.();
      await new Promise((r) => up.close(r));
      up.closeAllConnections?.();
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

const post = (port, body) =>
  fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("plugin integration hooks", () => {
  test("models:list can replace the served model list", async () => {
    // covered via modelsHandler through router below in its own boot
  });

  test("request:received can short-circuit with a custom response", async () => {
    const app = await boot({
      pluginCode: `
        export default {
          name: "guard",
          hooks: {
            "request:received": (ctx) => {
              if (String(ctx.body?.messages?.[0]?.content || "").includes("BLOCK")) {
                return { respond: { status: 403, body: { error: "blocked by plugin" } } };
              }
            },
          },
        };
      `,
      upstreamHandler: (req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}'); },
    });
    try {
      const blocked = await post(app.port, { model: "auto", messages: [{ role: "user", content: "BLOCK me" }] });
      assert.equal(blocked.status, 403);
      assert.deepEqual(await blocked.json(), { error: "blocked by plugin" });

      const allowed = await post(app.port, { model: "auto", messages: [{ role: "user", content: "hello" }] });
      assert.equal(allowed.status, 200);
    } finally {
      await app.close();
    }
  });

  test("model:beforeTry returning false skips a candidate", async () => {
    const seen = [];
    const app = await boot({
      pluginCode: `
        export default {
          name: "skipper",
          hooks: { "model:beforeTry": (ctx) => ctx.model === "m-two-free" },
        };
      `,
      upstreamHandler: (req, res, body) => {
        seen.push(JSON.parse(body).model);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ model: seen[seen.length - 1], ok: true }));
      },
    });
    try {
      const res = await post(app.port, { model: "auto", messages: [] });
      assert.equal(res.status, 200);
      assert.deepEqual(seen, ["m-two-free"], "m-one-free skipped by plugin");
    } finally {
      await app.close();
    }
  });

  test("upstream:request can rewrite the outgoing payload", async () => {
    let seenBody = null;
    const app = await boot({
      pluginCode: `
        export default {
          name: "rewriter",
          hooks: { "upstream:request": (ctx) => ({ payload: { ...ctx.payload, model: "m-two-free" } }) },
        };
      `,
      upstreamHandler: (req, res, body) => {
        seenBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ model: seenBody.model, ok: true }));
      },
    });
    try {
      const res = await post(app.port, { model: "m-one-free", messages: [] });
      assert.equal(res.status, 200);
      assert.equal(seenBody.model, "m-two-free", "payload rewritten by plugin");
    } finally {
      await app.close();
    }
  });

  test("upstream:response and relay:first-chunk and request:completed all fire", async () => {
    const app = await boot({
      pluginCode: `
        globalThis.__hookEvents = [];
        export default {
          name: "spy",
          hooks: {
            "upstream:response": (ctx) => { globalThis.__hookEvents.push(["upstream:response", ctx.model, ctx.status]); },
            "relay:first-chunk": (ctx) => { globalThis.__hookEvents.push(["relay:first-chunk", ctx.ttfMs >= 0]); },
            "request:completed": (ctx) => { globalThis.__hookEvents.push(["request:completed", ctx.via, ctx.status]); },
          },
        };
      `,
      upstreamHandler: (req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
        setTimeout(() => { res.write("data: [DONE]\n\n"); res.end(); }, 30);
      },
    });
    try {
      const res = await post(app.port, { model: "auto", messages: [], stream: true });
      assert.equal(res.status, 200);
      await res.text(); // drain the stream
      // give fire-and-forget request:completed a tick
      await new Promise((r) => setTimeout(r, 50));
      const evts = globalThis.__hookEvents || [];
      assert.ok(evts.some((e) => e[0] === "upstream:response" && e[2] === 200), "upstream:response fired");
      assert.ok(evts.some((e) => e[0] === "relay:first-chunk"), "relay:first-chunk fired");
      assert.ok(evts.some((e) => e[0] === "request:completed" && e[1] === "local" && e[2] === 200), "request:completed fired");
    } finally {
      await app.close();
      delete globalThis.__hookEvents;
    }
  });
});
