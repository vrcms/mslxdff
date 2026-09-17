import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleViaRoute } from "../src/routes/chat/via-route-handler.js";
import { saveProviderKeys } from "../src/state.js";

// 场景：A 与供应商 GGG 网络不畅 → 借 B 的出口 + A 的 key 调 GGG。
// 契约（ADR-0019）：转发即附带（组内互信），只有 opencode/刷新型凭据被硬排除。

function tempDir() {
  return mkdtempSync(join(tmpdir(), "mslxdff-test-via-share-"));
}

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    wrote: [],
    ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = String(v); },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    write(c) { this.wrote.push(Buffer.isBuffer(c) ? c.toString("utf8") : String(c)); return true; },
    end() { this.ended = true; },
    on() { return this; },
    removeListener() { return this; },
  };
}

function stubPeer() {
  const seen = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ headers: req.headers, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "stub", object: "chat.completion", model: "openrouter/foo", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({ srv, seen, port: srv.address().port }));
  });
}

async function runViaRoute({ dir, port, model = "openrouter/foo" }) {
  const stateFile = join(dir, "state.json");
  const routesFile = join(dir, "via-routes.json");
  writeFileSync(routesFile, JSON.stringify({
    version: 1,
    at: new Date().toISOString(),
    routes: {
      [model]: { best: `via:127.0.0.1:${port}`, direct: { ok: false }, via: { [`127.0.0.1:${port}`]: { ok: true } }, provider: "openrouter", at: new Date().toISOString() },
    },
    meta: {},
  }));
  process.env.MSLXDFF_STATE_FILE = stateFile;
  process.env.MSLXDFF_VIA_ROUTES_FILE = routesFile;
  saveProviderKeys("openrouter", ["sk-test-1", "sk-test-2"], { file: stateFile });
  return await handleViaRoute({
    model,
    body: { model, stream: false, messages: [{ role: "user", content: "hi" }] },
    peers: {
      ordered: () => [{ url: `http://127.0.0.1:${port}`, token: "peer-tok", name: "" }],
      orderedByLastError: () => [],
      recordError: async () => {},
      recordResult: async () => {},
    },
    handlerCtx: { reqId: "t-via", hops: 0 },
    evt: () => {},
    logCall: () => {},
    logError: () => {},
    mark: () => {},
    perf0: Date.now(),
    stages: [],
    startedAt: Date.now(),
    plugins: [],
    res: fakeRes(),
    requested: model,
    useAuto: false,
    lockModel: null,
    auto: null,
  });
}

test("via-route：默认借出 —— 借道时自动附带该供应商 key（ADR-0019）", async () => {
  const dir = tempDir();
  const peer = await stubPeer();
  try {
    const r = await runViaRoute({ dir, port: peer.port });
    assert.equal(r.handled, true);
    assert.equal(peer.seen.length, 1, "应恰好转发一次到 peer");
    assert.equal(peer.seen[0].headers["x-mslxdff-share-keys"], "openrouter=sk-test-1,sk-test-2");
  } finally {
    delete process.env.MSLXDFF_STATE_FILE;
    delete process.env.MSLXDFF_VIA_ROUTES_FILE;
    peer.srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("via-route：默认供应商（opencode 裸 id）永不附带 key", async () => {
  const dir = tempDir();
  const peer = await stubPeer();
  try {
    process.env.MSLXDFF_STATE_FILE = join(dir, "state.json");
    process.env.MSLXDFF_VIA_ROUTES_FILE = join(dir, "via-routes.json");
    saveProviderKeys("opencode", ["sk-should-never-leave"], { file: join(dir, "state.json") });
    const r = await runViaRoute({ dir, port: peer.port, model: "big-pickle" });
    assert.equal(r.handled, true);
    assert.equal(peer.seen[0].headers["x-mslxdff-share-keys"], undefined);
  } finally {
    delete process.env.MSLXDFF_STATE_FILE;
    delete process.env.MSLXDFF_VIA_ROUTES_FILE;
    peer.srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
