// DeepSeek 防禁言体系：差异化冷却 + 空闲最久轮换 + health 探活（全 fake，不打真机）
// 参考出处：TQZHR/deepseek2api（频率前兆/冷却）、NIyueeE/ds-free-api（health_check + 空闲最久池）
import assert from "node:assert/strict";
import test from "node:test";

import { createAuthPool, COOLDOWN_PRESETS } from "../src/providers/deepseek/auth.js";
import { deepseekHealth } from "../src/providers/deepseek/health.js";
import { deepSeekHashV1 } from "../src/providers/deepseek/hash.js";

const BASE = "https://chat.deepseek.com";

// ---------- T1 差异化冷却 ----------
test("cooldown: 默认 30s（无参 onError 向后兼容）", () => {
  let now = 1_000_000;
  const clock = () => now;
  const pool = createAuthPool({ tokens: ["a", "b"], clock });
  pool.onError("a");
  now += 29_000;
  assert.equal(pool.next(), "b"); // a 仍冷却
  now += 2_000;
  assert.equal(pool.next(), "a"); // 31s 恢复
});

test("cooldown: frequency 60s — 29s 不可用、61s 恢复", () => {
  let now = 1_000_000;
  const clock = () => now;
  const pool = createAuthPool({ tokens: ["a", "b"], clock });
  pool.onError("a", { cooldownMs: COOLDOWN_PRESETS.frequency });
  now += 29_000;
  assert.equal(pool.next(), "b");
  now += 32_000;
  assert.equal(pool.next(), "a");
});

test("cooldown: muted 5min — 4min 不可用、6min 恢复", () => {
  let now = 1_000_000;
  const clock = () => now;
  const pool = createAuthPool({ tokens: ["a", "b"], clock });
  pool.onError("a", { cooldownMs: COOLDOWN_PRESETS.muted });
  now += 4 * 60_000;
  assert.equal(pool.next(), "b");
  now += 2 * 60_000;
  assert.equal(pool.next(), "a");
});

// ---------- T2 空闲最久轮换 ----------
test("rotation: 平局保序（首轮 a,b,c 与 round-robin 一致）", () => {
  const pool = createAuthPool({ tokens: ["a", "b", "c"], clock: () => 1_000_000 });
  assert.equal(pool.next(), "a");
  assert.equal(pool.next(), "b");
  assert.equal(pool.next(), "c");
  assert.equal(pool.next(), "a");
});

test("rotation: 从未使用的号优先摊开（新号先被风控见到）", () => {
  let now = 1_000_000;
  const clock = () => now;
  const pool = createAuthPool({ tokens: ["a", "b"], clock });
  assert.equal(pool.next(), "a"); // 首轮平局保序
  now += 100_000;
  assert.equal(pool.next(), "b"); // b 从未用（idle 最大）→ 优先于刚用过的 a
});

test("rotation: 冷却恢复后复用最久未用号（最大化单号间隔）", () => {
  let now = 1_000_000;
  const clock = () => now;
  const pool = createAuthPool({ tokens: ["a", "b", "c"], clock });
  pool.next();
  pool.next();
  pool.next(); // a,b,c 首轮
  pool.onError("c"); // c 冷却
  now += 100_000;
  assert.equal(pool.next(), "a"); // a 最久未用
  assert.equal(pool.next(), "b");
  assert.equal(pool.next(), "c"); // c 冷却恢复，idle 最大 → 复用 c
});

// ---------- T3 health 探活 ----------
function fakeResponder(routes) {
  return { fetchImpl: async (url, opts = {}) => {
    const path = String(url).replace(BASE, "");
    const handler = routes[path] || routes[path.split("?")[0]];
    if (!handler) return new Response(JSON.stringify({ msg: "no route" }), { status: 404 });
    return handler(opts);
  } };
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}
function sse(text) {
  return new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
const OK_SSE = 'data: {"v":"[MSG]","o":"APPEND","p":"response/x"}\n\ndata: {"v":"[DONE]","o":"FINISHED","p":"response/x"}\n\n';

function tokenFromOpts(opts) {
  const auth = String(opts?.headers?.Authorization || "");
  return auth.replace(/^Bearer /, "") || "tk";
}

// 可解 challenge：nonce=7 在 difficulty=100 空间内（同 deepseek-pow-io 做法约束）
function inSpaceChallenge(salt) {
  return {
    algorithm: "DeepSeekHashV1",
    salt,
    expire_at: 1757000000,
    signature: "sig",
    difficulty: 100,
    target_path: "/api/v0/chat/completion",
    challenge: deepSeekHashV1(`${salt}_1757000000_7`),
  };
}

test("health: 健康✓ + muted✗（自动冷却 5min）+ 报告逐账号", async () => {
  let now = 1_000_000;
  const clock = () => now;
  const pool = createAuthPool({ tokens: ["tk-ok", "tk-muted"], clock });
  const { fetchImpl } = fakeResponder({
    "/api/v0/chat/create_pow_challenge": ({ headers }) => {
      const tk = tokenFromOpts({ headers: { Authorization: headers.Authorization } });
      return json({ code: 0, data: { biz_code: 0, biz_data: { challenge: inSpaceChallenge(`salt-${tk}`) } } });
    },
    "/api/v0/chat_session/create": ({ headers }) => {
      const tk = tokenFromOpts({ headers: { Authorization: headers.Authorization } });
      if (tk === "tk-muted") return json({ code: 0, data: { biz_code: 0, biz_data: { id: "sess-x" } } });
      return json({ code: 0, data: { biz_code: 0, biz_data: { id: `sess-${tk}` } } });
    },
    "/api/v0/chat/completion": ({ headers }) => {
      const tk = tokenFromOpts({ headers: { Authorization: headers.Authorization } });
      if (tk === "tk-muted") return json({ code: 0, msg: "", data: { biz_code: 1, biz_msg: "user is muted", biz_data: null } });
      return sse(OK_SSE);
    },
  });
  const report = await deepseekHealth({ authPool: pool, fetchImpl, baseUrl: BASE });
  assert.equal(report.length, 2);
  assert.equal(report[0].ok, true, `tk-ok 应健康: ${report[0].detail}`);
  assert.equal(report[1].ok, false, "tk-muted 应异常");
  assert.match(report[1].detail, /禁言/);
  assert.match(report[0].tokenTail, /ok$/);
  assert.equal(pool.available(), 1); // muted 已被探活冷却
  now += 6 * 60_000;
  assert.equal(pool.available(), 2); // 5min 冷却过后自动恢复
});

test("health: 限频 biz_code → 异常（默认冷却）不误判禁言", async () => {
  const pool = createAuthPool({ tokens: ["tk-freq"], clock: () => 1_000_000 });
  const { fetchImpl } = fakeResponder({
    "/api/v0/chat/create_pow_challenge": ({ headers }) => json({ code: 0, data: { biz_code: 0, biz_data: { challenge: inSpaceChallenge(`salt-${tokenFromOpts({ headers })}`) } } }),
    "/api/v0/chat_session/create": () => json({ code: 0, data: { biz_code: 0, biz_data: { id: "sess-f" } } }),
    "/api/v0/chat/completion": () => json({ code: 0, msg: "", data: { biz_code: 999, biz_msg: "消息发送过于频繁，请稍后重试", biz_data: null } }),
  });
  const report = await deepseekHealth({ authPool: pool, fetchImpl, baseUrl: BASE });
  assert.equal(report[0].ok, false);
  assert.match(report[0].detail, /过于频繁/);
  assert.equal(pool.available(), 0); // 30s 默认冷却
});

test("health: 网络失败 → 标注网络异常，不误伤冷却", async () => {
  const pool = createAuthPool({ tokens: ["tk-net"], clock: () => 1_000_000 });
  const fetchImpl = async () => { throw new Error("ECONNRESET boom"); };
  const report = await deepseekHealth({ authPool: pool, fetchImpl, baseUrl: BASE });
  assert.equal(report[0].ok, false);
  assert.match(report[0].detail, /网络/);
  assert.equal(pool.available(), 1); // 网络抖动不冷却
});
