import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

function stub(handler) {
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}
function urlOf(srv) { return `http://127.0.0.1:${srv.address().port}`; }
async function closeSrv(srv) { await new Promise((r) => srv.close(r)); srv.closeAllConnections?.(); }

test("chat: balance 0 skips request without touching network", async () => {
  let hit = false;
  const srv = await stub(() => { hit = true; });
  try {
    const { createWorkbuddyProvider } = await import("../src/providers/workbuddy/index.js");
    const { createBalanceCache } = await import("../src/providers/workbuddy/balance.js");
    const bal = createBalanceCache();
    bal.setCachedBalance("uid-zero", { total: 0, dailyPacks: 0, activeCount: 0, nextExpire: null });
    const p = createWorkbuddyProvider({
      baseUrl: urlOf(srv),
      apiKeys: ["k1"],
      auths: [{ uid: "uid-zero", domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "rt" }],
      balanceCache: bal,
      logger: { append() {} },
    });
    const res = await p.chat({ model: "hy3", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 403);
    assert.equal(hit, false, "should not fetch when balance 0");
    const j = await res.json();
    assert.match(j.error, /balance 0|cooling/i);
    await p.close();
  } finally { await closeSrv(srv); }
});

test("chat: 402 insufficient rotates to next account", async () => {
  let calls = [];
  const srv = await stub((req, res, body) => {
    if (req.url.includes("/v2/chat/completions")) {
      const uid = req.headers["x-user-id"];
      calls.push(uid);
      if (uid === "uid-a") {
        res.writeHead(402, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "insufficient quota" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("data: ok\n\n");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 0, data: { accessToken: "k-new" } }));
  });
  try {
    const { createWorkbuddyProvider } = await import("../src/providers/workbuddy/index.js");
    const { createBalanceCache } = await import("../src/providers/workbuddy/balance.js");
    const bal = createBalanceCache();
    const p = createWorkbuddyProvider({
      baseUrl: urlOf(srv),
      apiKeys: ["k-a", "k-b"],
      auths: [
        { uid: "uid-a", domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "rt-a" },
        { uid: "uid-b", domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "rt-b" },
      ],
      balanceCache: bal,
      logger: { append() {} },
    });
    const res = await p.chat({ model: "hy3", messages: [] });
    assert.equal(res.status, 200);
    assert.deepEqual(calls, ["uid-a", "uid-b"]);
    // 第一个账号应被标记余额 0
    const cached = bal.getCachedBalance("uid-a");
    assert.equal(cached?.total, 0);
    await p.close();
  } finally { await closeSrv(srv); }
});

test("chat: pin uid mode stays on single key and does not rotate", async () => {
  let calls = [];
  const srv = await stub((req, res) => {
    if (req.url.includes("/v2/chat/completions")) {
      calls.push(req.headers["x-user-id"]);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 0 }));
  });
  try {
    const { createWorkbuddyProvider } = await import("../src/providers/workbuddy/index.js");
    const p = createWorkbuddyProvider({
      baseUrl: urlOf(srv),
      apiKeys: ["k-a", "k-b"],
      auths: [
        { uid: "uid-a", domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "rt-a" },
        { uid: "uid-b", domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "rt-b" },
      ],
      logger: { append() {} },
    });
    const res = await p.chat({ model: "hy3", messages: [] }, { workbuddyUid: "uid-a" });
    // pin 模式下，500 会重试但不会切到 uid-b，且会返回 500
    assert.equal(res.status, 500);
    assert.ok(calls.every((u) => u === "uid-a"));
    assert.equal(calls.length >= 1, true);
    await p.close();
  } finally { await closeSrv(srv); }
});

test("chat: chatWithKeys does not mutate original keys/authList", async () => {
  const srv = await stub((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end("data: ok\n\n");
  });
  try {
    const { createWorkbuddyProvider } = await import("../src/providers/workbuddy/index.js");
    const p = createWorkbuddyProvider({
      baseUrl: urlOf(srv),
      apiKeys: ["k-a"],
      auths: [{ uid: "uid-a", domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "rt-a" }],
      logger: { append() {} },
    });
    const beforeKeys = [...p.keyRing.keys];
    // 需先开启 share 才走 chatWithKeys；通过注入 share 判定：直接调用 provider.chatWithKeys 并验证不污染
    // 若 share 关闭，chatWithKeys 会回落到普通 chat；此处验证不变式：调用前后 keys 不变
    await p.chatWithKeys({ model: "hy3", messages: [] }, ["k-shared"]);
    const afterKeys = [...p.keyRing.keys];
    assert.deepEqual(afterKeys, beforeKeys);
    // 并发不变式：两次并发 chatWithKeys 不互盖
    await Promise.all([
      p.chatWithKeys({ model: "hy3", messages: [] }, ["k-shared-1"]),
      p.chatWithKeys({ model: "hy3", messages: [] }, ["k-shared-2"]),
    ]);
    assert.deepEqual([...p.keyRing.keys], beforeKeys);
    await p.close();
  } finally { await closeSrv(srv); }
});

test("chat: forced stream true even when body stream false", async () => {
  let seenBody = null;
  const srv = await stub((req, res, body) => {
    if (req.url.includes("/v2/chat/completions")) {
      seenBody = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("data: ok\n\n");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 0 }));
  });
  try {
    const { createWorkbuddyProvider } = await import("../src/providers/workbuddy/index.js");
    const p = createWorkbuddyProvider({
      baseUrl: urlOf(srv),
      apiKeys: ["k1"],
      auths: [{ uid: "uid1", domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "rt1" }],
      logger: { append() {} },
    });
    const res = await p.chat({ model: "hy3", messages: [], stream: false });
    assert.equal(res.status, 200);
    assert.equal(seenBody.stream, true);
    await p.close();
  } finally { await closeSrv(srv); }
});
