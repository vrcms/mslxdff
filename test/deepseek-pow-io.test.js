import assert from "node:assert/strict";
import test from "node:test";

import { buildPowHeader, fetchPowChallenge, solveChallenge } from "../src/providers/deepseek/pow.js";

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

const CHALLENGE = {
  algorithm: "DeepSeekHashV1",
  challenge: "0".repeat(64),
  salt: "abc",
  expire_at: 1757000000,
  signature: "sig123",
  difficulty: 100,
  target_path: "/api/v0/chat/completion",
};

function jsonOk(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("fetchPowChallenge posts to create_pow_challenge with auth+android headers", async () => {
  const { calls, fetchImpl } = fakeResponder({
    "/api/v0/chat/create_pow_challenge": ({ headers }) => {
      assert.equal(headers.Authorization, "Bearer tk1");
      assert.equal(headers["x-client-platform"], "android");
      assert.equal(headers["User-Agent"], "DeepSeek/1.0.13 Android/35");
      return jsonOk({ code: 0, data: { biz_code: 0, biz_data: { challenge: CHALLENGE } } });
    },
  });
  const challenge = await fetchPowChallenge({ token: "tk1", fetchImpl, baseUrl: BASE });
  assert.equal(challenge.salt, "abc");
  assert.match(calls[0].url, /\/api\/v0\/chat\/create_pow_challenge$/);
  assert.equal(JSON.parse(calls[0].opts.body).target_path, "/api/v0/chat/completion");
});

test("fetchPowChallenge throws human error on biz failure", async () => {
  const { fetchImpl } = fakeResponder({
    "/api/v0/chat/create_pow_challenge": () => jsonOk({ code: 40001, msg: "未登录", data: { biz_code: 40001 } }),
  });
  await assert.rejects(
    () => fetchPowChallenge({ token: "tk1", fetchImpl, baseUrl: BASE }),
    /未登录|DeepSeek PoW 挑战获取失败/
  );
});

test("buildPowHeader encodes base64 JSON with all challenge fields", () => {
  const header = buildPowHeader(CHALLENGE, 42);
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  assert.equal(decoded.algorithm, "DeepSeekHashV1");
  assert.equal(decoded.challenge, CHALLENGE.challenge);
  assert.equal(decoded.salt, "abc");
  assert.equal(decoded.answer, 42);
  assert.equal(decoded.signature, "sig123");
  assert.equal(decoded.target_path, "/api/v0/chat/completion");
});

test("solveChallenge end-to-end: fetch → solve → header (with in-space challenge)", async () => {
  // 用 hash.js 构造一个空间内的 challenge：nonce=7
  const { deepSeekHashV1 } = await import("../src/providers/deepseek/hash.js");
  const prefix = `${CHALLENGE.salt}_${CHALLENGE.expire_at}_`;
  const realChallenge = { ...CHALLENGE, challenge: deepSeekHashV1(`${prefix}7`) };

  const { fetchImpl } = fakeResponder({
    "/api/v0/chat/create_pow_challenge": () => jsonOk({ code: 0, data: { biz_code: 0, biz_data: { challenge: realChallenge } } }),
  });

  const result = await solveChallenge({ token: "tk1", fetchImpl, baseUrl: BASE });
  assert.equal(result.answer, 7);
  const decoded = JSON.parse(Buffer.from(result.header, "base64").toString("utf8"));
  assert.equal(decoded.challenge, realChallenge.challenge);
  assert.equal(decoded.answer, 7);
});

test("solveChallenge throws when solver cannot find answer", async () => {
  // difficulty=100 但 challenge 是 nonce=200000 的 hash → 空间外
  const { deepSeekHashV1 } = await import("../src/providers/deepseek/hash.js");
  const prefix = `${CHALLENGE.salt}_${CHALLENGE.expire_at}_`;
  const outOfSpace = { ...CHALLENGE, difficulty: 100, challenge: deepSeekHashV1(`${prefix}200000`) };
  const { fetchImpl } = fakeResponder({
    "/api/v0/chat/create_pow_challenge": () => jsonOk({ code: 0, data: { biz_code: 0, biz_data: { challenge: outOfSpace } } }),
  });
  await assert.rejects(() => solveChallenge({ token: "tk1", fetchImpl, baseUrl: BASE }), /PoW/);
});
