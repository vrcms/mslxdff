import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleViaRoute } from "../src/routes/chat/via-route-handler.js";
import { saveProviderKeys } from "../src/state.js";

// P0-3 复现：借道时对端在 200 + SSE 头之后断链（组网最常见失败形态）。
// 旧行为：pipeline 返回 handled:false 被 via handler 丢弃 → 上层不再 failover → 响应永不 end。

function tempDir() {
  return mkdtempSync(join(tmpdir(), "mslxdff-test-via-timeout-"));
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

// 对端：回 200 + SSE 头，随后立刻销毁 socket（首字节前失败）
function deadSsePeer() {
  const srv = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
    setTimeout(() => { try { res.destroy(); } catch {} }, 20);
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port })));
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
  saveProviderKeys("openrouter", ["sk-test-1"], { file: stateFile });
  const res = fakeRes();
  const r = await handleViaRoute({
    model,
    body: { model, stream: true, messages: [{ role: "user", content: "hi" }] },
    peers: {
      ordered: () => [{ url: `http://127.0.0.1:${port}`, token: "peer-tok", name: "" }],
      orderedByLastError: () => [],
      recordError: async () => {},
      recordResult: async () => {},
    },
    handlerCtx: { reqId: "t-via-timeout", hops: 0 },
    evt: () => {},
    logCall: () => {},
    logError: () => {},
    mark: () => {},
    perf0: Date.now(),
    stages: [],
    startedAt: Date.now(),
    plugins: [],
    res,
    requested: model,
    useAuto: false,
    lockModel: null,
    auto: null,
  });
  return { r, res };
}

test("via-route：对端 SSE 头后断链 → handled:false 交回上层（旧行为丢弃 → 响应挂死）", async () => {
  const dir = tempDir();
  const peer = await deadSsePeer();
  try {
    const { r } = await runViaRoute({ dir, port: peer.port });
    assert.equal(r.handled, false, "failover 信号必须传播，否则上层不再换候选、响应永不收尾");
    assert.match(String(r.lastErr?.message), /stream timed out/, "lastErr 应说明首块超时");
  } finally {
    delete process.env.MSLXDFF_STATE_FILE;
    delete process.env.MSLXDFF_VIA_ROUTES_FILE;
    peer.srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
