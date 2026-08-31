import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

function b64url(obj) {
  const json = JSON.stringify(obj);
  return Buffer.from(json).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function makeJwt(exp) {
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const payload = b64url({ exp, uid: "u1" });
  return `${header}.${payload}.sig`;
}

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

// 需从深模块导入（重构后才存在，TDD 红阶段会失败）
test("auth: decodeJwtExp handles base64url with padding", async () => {
  const { decodeJwtExp } = await import("../src/providers/workbuddy/auth.js");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const tok = makeJwt(exp);
  assert.equal(decodeJwtExp(tok), exp);
});

test("auth: decodeJwtExp returns 0 for missing payload or invalid", async () => {
  const { decodeJwtExp } = await import("../src/providers/workbuddy/auth.js");
  assert.equal(decodeJwtExp(""), 0);
  assert.equal(decodeJwtExp("header.only"), 0);
  assert.equal(decodeJwtExp("a.b.c"), 0);
  assert.equal(decodeJwtExp(null), 0);
});

test("auth: isAuthError matches 401/403 and token keywords", async () => {
  const { isAuthError } = await import("../src/providers/workbuddy/auth.js");
  assert.equal(isAuthError(401, ""), true);
  assert.equal(isAuthError(403, ""), true);
  assert.equal(isAuthError(200, "token expired please login"), true);
  assert.equal(isAuthError(200, "Unauthorized"), true);
  assert.equal(isAuthError(200, "invalid token"), true);
  assert.equal(isAuthError(400, "token invalid"), true);
  assert.equal(isAuthError(200, "ok"), false);
  assert.equal(isAuthError(500, "ok"), false);
});

test("auth: isInsufficientStatus handles cached zero and 402", async () => {
  const { isInsufficientStatus } = await import("../src/providers/workbuddy/auth.js");
  assert.equal(isInsufficientStatus(402, "", null), true);
  assert.equal(isInsufficientStatus(200, "", { total: 0 }), true);
  assert.equal(isInsufficientStatus(403, "insufficient quota", null), true);
  assert.equal(isInsufficientStatus(429, "balance exhausted", null), true);
  assert.equal(isInsufficientStatus(200, "ok", null), false);
  assert.equal(isInsufficientStatus(200, "", { total: 100 }), false);
});

test("auth: concurrent same uid dedupes refresh to single fetch", async () => {
  let refreshCalls = 0;
  const srv = await stub((req, res) => {
    if (req.url.includes("/v2/plugin/auth/token/refresh")) {
      refreshCalls++;
      // delay to allow concurrency
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 0, data: { accessToken: makeJwt(Math.floor(Date.now()/1000)+3600), refreshToken: "rt-new" } }));
      }, 30);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 0 }));
  });
  try {
    const { createAuthService } = await import("../src/providers/workbuddy/auth.js");
    const auth = { uid: "uid-dedup", domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "rt-old" };
    const svc = createAuthService({ baseUrl: urlOf(srv), fetchImpl: fetch, clock: Date.now });
    // 并发两次同 uid 刷新
    const p1 = svc.refreshTokenFor("k-old", auth);
    const p2 = svc.refreshTokenFor("k-old", auth);
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1, r2);
    assert.equal(refreshCalls, 1, "deduped to single fetch");
  } finally { await closeSrv(srv); }
});

test("auth: maybeProactiveRefresh triggers within 5min and skips when far expired", async () => {
  let refreshCalls = 0;
  const srv = await stub((req, res) => {
    if (req.url.includes("/v2/plugin/auth/token/refresh")) {
      refreshCalls++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0, data: { accessToken: makeJwt(Math.floor(Date.now()/1000)+3600), refreshToken: "rt-new" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 0 }));
  });
  try {
    const { createAuthService } = await import("../src/providers/workbuddy/auth.js");
    const expSoon = Math.floor(Date.now()/1000) + 2*60; // 2min 后过期
    const expFar = Math.floor(Date.now()/1000) - 2*3600; // 2h 前已过期
    const tokSoon = makeJwt(expSoon);
    const tokFar = makeJwt(expFar);
    const auth = { uid: "uid-proactive", domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "rt-old" };

    // 注入可控 clock 与内存 store
    const memStore = { saved: null, save(id, cfg) { this.saved = cfg; } };
    const svcSoon = createAuthService({ baseUrl: urlOf(srv), fetchImpl: fetch, clock: Date.now, store: memStore });

    svcSoon.maybeProactiveRefresh(auth, tokSoon);
    // 等待后台刷新
    await new Promise(r => setTimeout(r, 80));
    assert.equal(refreshCalls, 1, "should trigger proactive within 5min");

    refreshCalls = 0;
    const svcFar = createAuthService({ baseUrl: urlOf(srv), fetchImpl: fetch, clock: Date.now, store: memStore });
    svcFar.maybeProactiveRefresh(auth, tokFar);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(refreshCalls, 0, "far expired should not trigger");
  } finally { await closeSrv(srv); }
});
