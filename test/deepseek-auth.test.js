import assert from "node:assert/strict";
import test from "node:test";

import { androidHeaders, loginDeepseek, createAuthPool } from "../src/providers/deepseek/auth.js";
import { createChatSession, deleteChatSession } from "../src/providers/deepseek/session.js";

const BASE = "https://chat.deepseek.com";

function fakeResponder(routes) {
  const calls = [];
  return { calls, fetchImpl: async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const path = String(url).replace(BASE, "");
    const handler = routes[path] || routes[path.split("?")[0]];
    if (!handler) return new Response(JSON.stringify({ msg: "no route" }), { status: 404 });
    return handler(opts);
  } };
}

function jsonOk(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

test("androidHeaders: base + auth when token present", () => {
  const h = androidHeaders("tk1");
  assert.equal(h["User-Agent"], "DeepSeek/1.0.13 Android/35");
  assert.equal(h["x-client-platform"], "android");
  assert.equal(h["x-client-version"], "2.0.0");
  assert.equal(h.Authorization, "Bearer tk1");
  assert.equal("Authorization" in androidHeaders(null), false);
});

test("loginDeepseek: email payload and token extraction", async () => {
  const { calls, fetchImpl } = fakeResponder({
    "/api/v0/users/login": ({ headers }) => {
      assert.equal(headers["x-client-platform"], "android");
      return jsonOk({ data: { biz_code: 0, biz_data: { user: { token: "tk1", id: 9 } } } });
    },
  });
  const out = await loginDeepseek({ loginValue: "a@b.com", password: "pw", fetchImpl, baseUrl: BASE });
  assert.equal(out.token, "tk1");
  assert.equal(out.userId, 9);
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.email, "a@b.com");
  assert.equal(body.mobile, "");
  assert.equal(body.os, "android");
});

test("loginDeepseek: mobile payload includes area_code", async () => {
  const { calls, fetchImpl } = fakeResponder({
    "/api/v0/users/login": () => jsonOk({ data: { biz_code: 0, biz_data: { user: { token: "tk" } } } }),
  });
  await loginDeepseek({ loginValue: "13800138000", password: "pw", areaCode: "+86", fetchImpl, baseUrl: BASE });
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.mobile, "13800138000");
  assert.equal(body.email, "");
  assert.equal(body.area_code, "+86");
});

test("loginDeepseek: biz failure surfaces human message", async () => {
  const { fetchImpl } = fakeResponder({
    "/api/v0/users/login": () => jsonOk({ data: { biz_code: 40001, biz_msg: "账号或密码错误" } }),
  });
  await assert.rejects(
    () => loginDeepseek({ loginValue: "a@b.com", password: "bad", fetchImpl, baseUrl: BASE }),
    /账号或密码错误/
  );
});

test("loginDeepseek: missing token in response errors humanly", async () => {
  const { fetchImpl } = fakeResponder({
    "/api/v0/users/login": () => jsonOk({ data: { biz_code: 0, biz_data: { user: {} } } }),
  });
  await assert.rejects(() => loginDeepseek({ loginValue: "a@b.com", password: "pw", fetchImpl, baseUrl: BASE }), /token/);
});

test("loginDeepseek: network error wrapped humanly", async () => {
  await assert.rejects(
    () => loginDeepseek({ loginValue: "a@b.com", password: "pw", fetchImpl: async () => { throw new Error("ECONNREFUSED"); }, baseUrl: BASE }),
    /DeepSeek 登录失败|ECONNREFUSED/
  );
});

test("createAuthPool: round-robins tokens and skips cooling accounts", () => {
  const clock = { now: 1000 };
  const pool = createAuthPool({ tokens: ["t1", "t2"], clock: () => clock.now });
  assert.equal(pool.next(), "t1");
  assert.equal(pool.next(), "t2");
  assert.equal(pool.next(), "t1");
  pool.onError("t1");
  assert.equal(pool.next(), "t2");
  assert.equal(pool.next(), "t2"); // t1 仍在冷却
  clock.now += 31_000;
  assert.equal(pool.next(), "t1"); // 冷却结束
});

test("createAuthPool: all cooling returns null", () => {
  const pool = createAuthPool({ tokens: ["t1"], clock: () => 0 });
  const t = pool.next();
  pool.onError(t);
  assert.equal(pool.next(), null);
  assert.equal(pool.available(), 0);
});

test("createAuthPool: empty tokens → next null, error message mentions login", () => {
  const pool = createAuthPool({ tokens: [] });
  assert.equal(pool.next(), null);
  assert.throws(() => pool.requireToken(), /-provider deepseek login|缺少 DeepSeek 凭据/);
});

test("createChatSession: returns biz_data.id with auth header", async () => {
  const { calls, fetchImpl } = fakeResponder({
    "/api/v0/chat_session/create": ({ headers }) => {
      assert.equal(headers.Authorization, "Bearer tk1");
      return jsonOk({ code: 0, data: { biz_code: 0, biz_data: { id: "sess-42" } } });
    },
  });
  const id = await createChatSession({ token: "tk1", fetchImpl, baseUrl: BASE });
  assert.equal(id, "sess-42");
  assert.equal(JSON.parse(calls[0].opts.body).agent, "chat");
});

test("deleteChatSession: posts chat_session_id, never throws on 500", async () => {
  const { calls, fetchImpl } = fakeResponder({
    "/api/v0/chat_session/delete": () => new Response("err", { status: 500 }),
  });
  await assert.doesNotReject(() => deleteChatSession({ token: "tk1", sessionId: "sess-42", fetchImpl, baseUrl: BASE }));
  assert.equal(JSON.parse(calls[0].opts.body).chat_session_id, "sess-42");
});
