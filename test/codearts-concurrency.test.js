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
// 流式桩：开头的头一段立即 flush，主体延迟 delayMs 后才结束——用来验证「流未读完前不许放行下一路」。
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

// 流式上游：拿到请求就把 inFlight++，**只有在响应 body 全部写完、连接真的收尾时才 --**。
// 用「头一段立即写 + 结尾延迟」制造「响应已返回但流仍在途」的窗口——正是旧闸漏算的地方。
function streamingStub({ tailDelayMs = 80 } = {}) {
  let inFlight = 0, peak = 0;
  const srv = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api/v2/chat/completions") {
        inFlight++;
        if (inFlight > peak) peak = inFlight;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${CHAT_SSE[0]}\n\n`); // 先吐一段
        setTimeout(() => {
          inFlight--;                          // 流真正收尾才释放
          res.end(CHAT_SSE.slice(1).map((f) => `data: ${f}\n\n`).join(""));
        }, tailDelayMs);
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

describe("codearts 并发闸 · 流式（回归：旧闸在 runChat 返回即放行，流没读完就放进下一路）", () => {
  let srv, dir, stateFile, savedEnv;
  beforeEach(async () => {
    srv = await streamingStub();
    dir = mkdtempSync(join(tmpdir(), "codearts-conc-s-"));
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
    return createCodeartsProvider({ baseUrl: srv.url, snapBase: srv.url, stsHost: srv.url, benefitHost: srv.url, apiKeys: [blob], file: stateFile, ...overrides });
  }
  const drain = async (res) => { try { await res.text(); } catch {} };

  test("流式：7 路并发也要把上游在途峰值压在 ≤3（流读完前不放行下一路）", async () => {
    const p = makeProvider();
    // 关键：拿 Response 后**就地读 body**（读完才会释放槽位让下一路进）——
    // 若像旧闸那样「返回即放行」，7 路会同时打到上游，peak 必 >3。
    const results = await Promise.all(
      Array.from({ length: 7 }, () =>
        p.chat({ model: "GLM-5.2", messages: [{ role: "user", content: "hi" }], stream: true })
          .then(async (res) => ({ status: res.status, text: await res.text() }))),
    );
    for (const res of results) assert.equal(res.status, 200);
    assert.ok(srv.peak() <= 3, `流式上游在途峰值应 ≤3，实测 ${srv.peak()}（>3 说明流没读完就放行了）`);
    assert.equal(p._gate.stats().active, 0, "全部流读完后不应有在途");
    assert.equal(p._gate.stats().queued, 0, "全部流读完后队列应清空");
    await p.close();
  });

  test("流式：只取到 Response 不读 body ⇒ 槽位仍被占（证明释放挂在流结束上）", async () => {
    const p = makeProvider();
    const r1 = await p.chat({ model: "GLM-5.2", messages: [], stream: true });
    assert.equal(r1.status, 200);
    assert.equal(p._gate.stats().active, 1, "流未消费 ⇒ 应仍占 1 个槽，不许提前释放");
    await drain(r1);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(p._gate.stats().active, 0, "流读完后应释放");
    await p.close();
  });
});

// 账号会话饱和：上游按账号限同时活跃会话数，TM.00001041 是账号此刻进不去（非参数错）。
// 多号场景应换另一个号重试，而不是把 400 直接抛给用户。
function saturatedOnceStub() {
  let calls = 0;
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api/v2/chat/completions") {
        calls++;
        if (calls === 1) { // 首号：饱和
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error_code: "TM.00001041", error_msg: "并发会话数已达上限(3个)，请关闭部分会话后重试。" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(CHAT_SSE.map((f) => `data: ${f}\n\n`).join("")); // 次号：成功
        return;
      }
      res.writeHead(404); res.end("{}");
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${srv.address().port}`, calls: () => calls,
    close: () => new Promise((r) => srv.close(r)),
  })));
}

describe("codearts 会话饱和换号", () => {
  let srv, dir, stateFile, savedEnv;
  beforeEach(async () => {
    srv = await saturatedOnceStub();
    dir = mkdtempSync(join(tmpdir(), "codearts-sat-"));
    stateFile = join(dir, "state.json");
    savedEnv = process.env.MSLXDFF_STATE_FILE;
    process.env.MSLXDFF_STATE_FILE = stateFile;
  });
  afterEach(async () => {
    process.env.MSLXDFF_STATE_FILE = savedEnv;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    await srv.close();
  });

  test("首号 TM.00001041 → 换第二个号重试成功（不再把 400 抛给用户）", async () => {
    const blobA = makeBlob();
    const blobB = makeBlob();
    saveProviderConfig("codearts", { baseUrl: srv.url, keys: [blobA, blobB] }, { file: stateFile });
    const p = createCodeartsProvider({
      baseUrl: srv.url, snapBase: srv.url, stsHost: srv.url, benefitHost: srv.url,
      apiKeys: [blobA, blobB], file: stateFile,
    });
    const res = await p.chat({ model: "GLM-5.2", messages: [{ role: "user", content: "hi" }], stream: false });
    assert.equal(res.status, 200, "撞账号饱和应换号重试并拿到 200");
    assert.ok(srv.calls() >= 2, `应至少打了两次上游（首号饱和 + 换号），实测 ${srv.calls()}`);
    await p.close();
  });
});

// 所有号都饱和：应如实回传上游 400 + TM.00001041，而不是笼统的 "all accounts unavailable"。
function alwaysSaturatedStub() {
  let calls = 0;
  const srv = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api/v2/chat/completions") {
        calls++;
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error_code: "TM.00001041", error_msg: "并发会话数已达上限(3个)，请关闭部分会话后重试。" }));
        return;
      }
      res.writeHead(404); res.end("{}");
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${srv.address().port}`, calls: () => calls,
    close: () => new Promise((r) => srv.close(r)),
  })));
}

describe("codearts 全号饱和", () => {
  let srv, dir, stateFile, savedEnv;
  beforeEach(async () => {
    srv = await alwaysSaturatedStub();
    dir = mkdtempSync(join(tmpdir(), "codearts-allsat-"));
    stateFile = join(dir, "state.json");
    savedEnv = process.env.MSLXDFF_STATE_FILE;
    process.env.MSLXDFF_STATE_FILE = stateFile;
  });
  afterEach(async () => {
    process.env.MSLXDFF_STATE_FILE = savedEnv;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    await srv.close();
  });

  test("两个号都饱和 → 400 且正文含 TM.00001041（不吞成 all accounts unavailable）", async () => {
    const blobA = makeBlob();
    const blobB = makeBlob();
    saveProviderConfig("codearts", { baseUrl: srv.url, keys: [blobA, blobB] }, { file: stateFile });
    const p = createCodeartsProvider({
      baseUrl: srv.url, snapBase: srv.url, stsHost: srv.url, benefitHost: srv.url,
      apiKeys: [blobA, blobB], file: stateFile,
    });
    const res = await p.chat({ model: "GLM-5.2", messages: [{ role: "user", content: "hi" }], stream: false });
    const txt = await res.text();
    assert.equal(res.status, 400);
    assert.ok(/TM\.00001041/.test(txt), `正文应含 TM.00001041，实测：${txt.slice(0, 160)}`);
    assert.ok(srv.calls() >= 2, `两个号各应打一次上游，实测 ${srv.calls()}`);
    await p.close();
  });
});
