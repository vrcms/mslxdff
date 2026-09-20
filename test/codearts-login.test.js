// codearts login 死锁回归：通道 2（ticket 轮询）启动后绝不阻塞事件循环，
// 浏览器带 code 的回调必须能被消费并完成换 token。
// 真机首登实测（2026-09-20）：await 轮询占死主循环 → 回调只进 hits 队列无人取，
// 页面显示"回调已收到"但终端永远轮询到超时。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { runCodeartsLogin } from "../src/providers/codearts/login.js";

function stub() {
  let handler = () => {};
  const hits = [];
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const hit = { url: req.url, method: req.method, headers: req.headers, body: raw };
      hits.push(hit);
      handler(req, res, hit);
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${srv.address().port}`,
    hits,
    set: (fn) => { handler = fn; },
    close: () => new Promise((r) => srv.close(r)),
  })));
}

describe("codearts login 双通道", () => {
  test("ticket 轮询启动后浏览器 code 回调仍能被消费（死锁回归）", async () => {
    const srv = await stub();
    try {
      srv.set((req, res, hit) => {
        if (req.method === "POST" && req.url === "/v1/oauth2/tokens") {
          const body = new URLSearchParams(hit.body || "");
          res.writeHead(200, { "Content-Type": "application/json" });
          if (body.get("grant_type") === "authorization_code") {
            res.end(JSON.stringify({
              user_id: "u1", user_name: "tester", domain_id: "d1",
              refresh_token: "rt-login-1",
              credentials: { access_key_id: "AK", secret_access_key: "SK", security_token: "ST", expiration: new Date(Date.now() + 3600_000).toISOString() },
            }));
          } else {
            res.end(JSON.stringify({ error: "invalid_grant" }));
          }
          return;
        }
        // ticket 轮询端点：恒不下发（404）——逼出"只有回调通道能赢"的场景
        res.writeHead(404); res.end("{}");
      });
      const logs = [];
      const p = runCodeartsLogin({
        snapBase: srv.url, stsHost: srv.url,
        timeoutMs: 20_000,
        log: (m) => logs.push(m),
      });
      // 从日志拿本机回调端口
      let redirectUri = "";
      for (let i = 0; i < 100 && !redirectUri; i++) {
        await new Promise((r) => setTimeout(r, 20));
        redirectUri = (logs.find((l) => l.includes("本机回调：")) || "")
          .replace(/.*本机回调：/, "").replace(/（.*/, "").trim();
      }
      assert.ok(redirectUri, "日志应打印本机回调地址");
      // 等 4s：保证主循环至少空转过一轮（null hit）→ ticket 轮询已在后台跑（复现死锁前态）
      await new Promise((r) => setTimeout(r, 4000));
      const { port, pathname } = new URL(redirectUri);
      const res = await fetch(`http://127.0.0.1:${port}${pathname}?code=auth-code-1&state=x`);
      assert.ok(res.ok, "回调页应 200");
      const { account, state } = await p;
      assert.equal(account.refreshToken, "rt-login-1");
      assert.equal(account.userId, "u1");
      assert.ok(state.codeVerifier, "verifier 随 state 透传");
    } finally {
      await srv.close();
    }
  });

  test("exchange 无身份时 lookupIdentity 补调 caller-identity（空身份回归）", async () => {
    const srv = await stub();
    const { lookupIdentity } = await import("../src/providers/codearts/login.js");
    try {
      srv.set((req, res) => {
        if (req.method === "GET" && req.url === "/v5/caller-identity") {
          assert.ok(req.headers.authorization?.startsWith("SDK-HMAC-SHA256"), "身份接口走 AK/SK 签名");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ account_id: "d9", principal_id: "u9", principal_urn: "iam::domain:d9:user:zhangsan" }));
          return;
        }
        res.writeHead(404); res.end("{}");
      });
      const id = await lookupIdentity({
        account: { accessKeyId: "AK", secretAccessKey: "SK", securityToken: "ST", refreshToken: "rt" },
        stsHost: srv.url, snapBase: srv.url,
      });
      assert.deepEqual(id, { userId: "u9", userName: "zhangsan", domainId: "d9" });
    } finally {
      await srv.close();
    }
  });

  test("caller-identity 失败时回退 current/user，再失败用 refresh JWT sub 兜底", async () => {
    const srv = await stub();
    const { lookupIdentity } = await import("../src/providers/codearts/login.js");
    try {
      srv.set((req, res) => {
        if (req.method === "GET" && req.url === "/v1/current/user") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ user_id: "u8", user_name: "lisi", domain_id: "d8" }));
          return;
        }
        res.writeHead(500); res.end("{}"); // caller-identity 挂掉
      });
      const id = await lookupIdentity({
        account: { accessKeyId: "AK", secretAccessKey: "SK", securityToken: "ST", refreshToken: "rt" },
        stsHost: srv.url, snapBase: srv.url, log: () => {},
      });
      assert.deepEqual(id, { userId: "u8", userName: "lisi", domainId: "d8" });
      // 两接口全挂 → JWT sub 兜底
      srv.set((req, res) => { res.writeHead(500); res.end("{}"); });
      const jwt = `e.${Buffer.from(JSON.stringify({ sub: "u7" })).toString("base64url")}.s`;
      const id2 = await lookupIdentity({
        account: { accessKeyId: "AK", secretAccessKey: "SK", securityToken: "ST", refreshToken: jwt },
        stsHost: srv.url, snapBase: srv.url, log: () => {},
      });
      assert.deepEqual(id2, { userId: "u7", userName: "", domainId: "" });
    } finally {
      await srv.close();
    }
  }, 30_000);
});
