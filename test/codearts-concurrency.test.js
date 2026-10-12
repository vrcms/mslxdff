// codearts 并发闸测试：验证上游在途并发被硬限在 maxConcurrent（默认 3），超限排队而非拒绝。
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { saveProviderConfig } from "../src/state.js";
import { createCodeartsProvider } from "../src/providers/codearts.js";
import { newDpopPrivateJwk } from "../src/providers/codearts/dpop.js";

const CHAT_SSE = [
  "{\"id\":1,\"model\":\"GLM-5.2\",\"type\":\"answer\",\"chat_id\":\"c\"}",
  "{\"text\":\"你好\",\"prompt_tokens\":10}",
  "{\"text\":\"你好世界\",\"completion_tokens\":5}",
  "{\"text\":\"[DONE]\",\"error_code\":\"0\"}",
];

function makeBlob() {
  return JSON.stringify({
    userId: "u1", userName: "tester", domainId: "d1",
    refreshToken: "rt-1", clientId: "codearts-agent",
    codeVerifier: "verifier-1", dpopJwk: newDpopPrivateJwk(),
    accessKeyId: "AK", secretAccessKey: "SK", securityToken: "ST",
    expiration: new Date(Date.now() + 3600_000).toISOString(),
  });
}

// 记录上游在途并发峰值；每个 chat 延迟 delayMs，保证并发请求真的重叠。
function concurrencyStub({ delayMs = 50 } = {}) {
  let inFlight = 0, peak = 0;
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api/v2/chat/completions") {
        inFlight++;
        if (inFlight > peak) peak = inFlight;
        setTimeout(() => {
          inFlight--;
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.end(CHAT_SSE.map((f) => `data: ${f}\n\n`).join(""));
        }, delayMs);
        return;
      }
      res.writeHead(404); res.end("{}");
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${srv.address().port}`,
    peak: () => peak,
    close: () => new Promise((r) => srv.close(r)),
  })));
}

describe("codearts 并发闸", () => {
  let srv, dir, stateFile, savedEnv;

  beforeEach(async () => {
    srv = await concurrencyStub();
    dir = mkdtempSync(join(tmpdir(), "codearts-conc-"));
    stateFile = join(dir, "state.json");
    savedEnv = process.env.MSLXDFF_STATE_FILE;
    process.env.MSLXDFF_STATE_FILE = stateFile;
  });

  afterEach(async () => {
    process.env.MSLXDFF_STATE_FILE = savedEnv;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    await srv.close();
  });

  function makeProvider(overrides = {}) {
    const blob = makeBlob();
    saveProviderConfig("codearts", { baseUrl: srv.url, keys: [blob] }, { file: stateFile });
    return createCodeartsProvider({
      baseUrl: srv.url, snapBase: srv.url, stsHost: srv.url, benefitHost: srv.url,
      apiKeys: [blob], file: stateFile, ...overrides,
    });
  }

  test("默认上限 3：7 个并发请求上游在途峰值 ≤3 且全成功", async () => {
    const p = makeProvider();
    const results = await Promise.all(
      Array.from({ length: 7 }, () =>
        p.chat({ model: "GLM-5.2", messages: [{ role: "user", content: "hi" }], stream: false })),
    );
    for (const res of results) assert.equal(res.status, 200);
    assert.ok(srv.peak() <= 3, `上游在途峰值应 ≤3，实测 ${srv.peak()}`);
    assert.equal(p._gate.stats().active, 0, "全部完成后不应有在途");
    assert.equal(p._gate.stats().queued, 0, "全部完成后队列应清空");
    await p.close();
  });

  test("maxConcurrent=0 → 不限并发（对照组，证明闸真的在限）", async () => {
    const p = makeProvider({ maxConcurrent: 0 });
    const results = await Promise.all(
      Array.from({ length: 7 }, () =>
        p.chat({ model: "GLM-5.2", messages: [{ role: "user", content: "hi" }], stream: false })),
    );
    for (const res of results) assert.equal(res.status, 200);
    assert.ok(srv.peak() > 3, `关闸时上游在途峰值应 >3，实测 ${srv.peak()}`);
    await p.close();
  });
});
