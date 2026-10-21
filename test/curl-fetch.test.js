// curl-fetch 适配器：对本地 stub server 验证 fetch 契约（非流式/流式/坏 URL 抛错/头解析）
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

const { createCurlFetch, parseHeaderBlob, headerBlobReady } = await import("../src/providers/curl-fetch.js");

function stub() {
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (req.url === "/json") {
        res.writeHead(200, { "Content-Type": "application/json", "X-Test": "yes" });
        res.end(JSON.stringify({ echo: raw, ua: req.headers["user-agent"] || "" }));
        return;
      }
      if (req.url === "/sse") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("data: a\n\n");
        setTimeout(() => res.write("data: b\n\n"), 120);
        setTimeout(() => { res.write("data: [DONE]\n\n"); res.end(); }, 240);
        return;
      }
      if (req.url === "/404") { res.writeHead(404, { "Content-Type": "application/json" }); res.end("{}"); return; }
      res.writeHead(500); res.end("boom");
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((x) => srv.close(x)) })));
}

describe("curl-fetch：fetch 契约", () => {
  let s;
  test.before(async () => { s = await stub(); });
  test.after(async () => { await s.close(); });

  test("POST JSON：body 送达、状态/响应头还原", async () => {
    const curlFetch = createCurlFetch();
    const res = await curlFetch(`${s.base}/json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "probe-ua" },
      body: JSON.stringify({ hi: 1 }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-test"), "yes");
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    const j = await res.json();
    assert.deepEqual(JSON.parse(j.echo), { hi: 1 });
    assert.equal(j.ua, "probe-ua");
  });

  test("SSE 流式：分块增量到齐（不被攒完再吐）", async () => {
    const curlFetch = createCurlFetch();
    const res = await curlFetch(`${s.base}/sse`, { method: "POST", headers: {}, body: "{}" });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const chunks = [];
    const t0 = Date.now();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push({ t: Date.now() - t0, s: new TextDecoder().decode(value) });
    }
    const all = chunks.map((c) => c.s).join("");
    assert.ok(all.includes("data: a") && all.includes("data: b") && all.includes("[DONE]"), "三帧齐全");
    assert.ok(chunks.length >= 2 && chunks.at(-1).t >= 200, `应分波到达（chunks=${chunks.length}, 末波=${chunks.at(-1)?.t}ms）`);
  });

  test("非 2xx：状态码原样返回（交上层判冷却），不抛错", async () => {
    const curlFetch = createCurlFetch();
    const res = await curlFetch(`${s.base}/404`, { method: "GET" });
    assert.equal(res.status, 404);
  });

  test("连不上的 URL：抛 Error（等价 fetch 网络层抛错）", async () => {
    const curlFetch = createCurlFetch({ headWaitMs: 3000 });
    await assert.rejects(
      () => curlFetch("http://127.0.0.1:1/json", { method: "POST", body: "{}" }),
      /curl-fetch/,
    );
  });

  test("signal 中止：抛错且进程被收（不挂死）", async () => {
    const curlFetch = createCurlFetch({ headWaitMs: 9000 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    await assert.rejects(() => curlFetch("http://127.0.0.1:1/x", { method: "POST", body: "{}", signal: ac.signal }));
  });
});

describe("curl-fetch：头块解析纯函数", () => {
  test("parseHeaderBlob：取最后一个 HTTP 段（代理 CONNECT 前置段跳过）", () => {
    const proxyBlob = "HTTP/1.1 200 Connection established\r\n\r\nHTTP/1.1 200 OK\r\ncontent-type: application/json\r\nx-t: 1\r\n\r\n";
    const { status, headers } = parseHeaderBlob(proxyBlob);
    assert.equal(status, 200);
    assert.equal(headers.get("x-t"), "1");
    assert.equal(headers.get("content-type"), "application/json");
  });
  test("parseHeaderBlob：100 Continue 中间应答段跳过，取终局段", () => {
    // Claude Code 大 body 实测事故：curl -D 先落 `HTTP/1.1 100 Continue`，
    // 若当终局则 new Response(status=100) 抛 RangeError → 502 → key 冷却连锁
    const blob = "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 429 Too Many Requests\r\nretry-after: 5\r\n\r\n";
    const { status, headers } = parseHeaderBlob(blob);
    assert.equal(status, 429);
    assert.equal(headers.get("retry-after"), "5");
  });
  test("headerBlobReady：CONNECT 伪头段不算就绪，真实头完整才算", () => {
    assert.equal(headerBlobReady("HTTP/1.1 200 Connection established\r\n\r\n"), false);
    assert.equal(headerBlobReady("HTTP/1.1 200 Connection established\r\n\r\nHTTP/1.1 404 Not Found\r\ncontent-type: application/json\r\n\r\n"), true);
    assert.equal(headerBlobReady("HTTP/1.1 404 Not Found\r\ncontent-type: application/json\r\n\r\n"), true);
    assert.equal(headerBlobReady("HTTP/1.1 200 OK\r\ncontent-type: text/plain"), false); // 未以空行收尾
  });
  test("headerBlobReady：100 Continue 单独出现不算就绪；100+终局段才算", () => {
    assert.equal(headerBlobReady("HTTP/1.1 100 Continue\r\n\r\n"), false);
    assert.equal(headerBlobReady("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n"), true);
  });
});
