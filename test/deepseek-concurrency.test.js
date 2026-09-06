// DeepSeek 每 token 并发闸门：acquireSlot 排队/超时/释放 + runDeepseekChat 集成（全 fake，不打真机）
// 参考：Chat2API-WXS per-account concurrency guard（acquire→FIFO→流结束释放，超时 429）
import assert from "node:assert/strict";
import test from "node:test";

import { createAuthPool } from "../src/providers/deepseek/auth.js";
import { runDeepseekChat } from "../src/providers/deepseek/chat.js";
import { deepSeekHashV1 } from "../src/providers/deepseek/hash.js";

const BASE = "https://chat.deepseek.com";

function jsonOk(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

// 真 PoW 可解 challenge（同 deepseek-provider.test.js 构造法：上游预选 nonce，客户端穷举还原）
const CHALLENGE = { algorithm: "DeepSeekHashV1", challenge: deepSeekHashV1("salt_1757000000_3"), salt: "salt", expire_at: 1757000000, signature: "sig", difficulty: 100, target_path: "/api/v0/chat/completion" };

// ---------- T1 authPool.acquireSlot 单元 ----------
test("acquireSlot: 空闲池立即返回 token 且 release 幂等", async () => {
  const pool = createAuthPool({ tokens: ["a"], clock: () => 1_000 });
  const s1 = await pool.acquireSlot({ timeoutMs: 100 });
  assert.equal(s1.token, "a");
  assert.equal(typeof s1.release, "function");
  s1.release();
  s1.release(); // 幂等：重复调用不崩
  const s2 = await pool.acquireSlot({ timeoutMs: 100 });
  assert.equal(s2.token, "a"); // 释放后可再取
  s2.release();
});

test("acquireSlot: 每 token 并发 1 — A 在途时拿 B 不等待", async () => {
  const pool = createAuthPool({ tokens: ["a", "b"], clock: () => 1_000 });
  const s1 = await pool.acquireSlot({ timeoutMs: 100 });
  assert.equal(s1.token, "a");
  const s2 = await pool.acquireSlot({ timeoutMs: 100 });
  assert.equal(s2.token, "b"); // 自动分散，未排队
  s1.release();
  s2.release();
});

test("acquireSlot: 全忙排队 — release 后等待者被唤醒", async () => {
  const pool = createAuthPool({ tokens: ["a"], clock: () => 1_000 });
  const s1 = await pool.acquireSlot({ timeoutMs: 100 });
  let acquired = null;
  const pending = pool.acquireSlot({ timeoutMs: 1_000 }).then((s) => (acquired = s));
  await new Promise((r) => setTimeout(r, 20)); // 等待者入队
  assert.equal(acquired, null); // 仍在排队
  s1.release();
  await pending;
  assert.equal(acquired.token, "a"); // 被唤醒拿到同一 token
  acquired.release();
});

test("acquireSlot: 全忙超时返回 null", async () => {
  const keep = setInterval(() => {}, 10); // 保活事件循环：timer.unref 不提前退出进程
  try {
    const pool = createAuthPool({ tokens: ["a"], clock: () => 1_000 });
    const s1 = await pool.acquireSlot({ timeoutMs: 60_000 });
    const t0 = Date.now();
    const s2 = await pool.acquireSlot({ timeoutMs: 30 });
    assert.equal(s2, null); // 超时
    assert.ok(Date.now() - t0 >= 25);
    s1.release();
  } finally {
    clearInterval(keep);
  }
});

test("acquireSlot: cooling 的号不被选中", async () => {
  const keep = setInterval(() => {}, 10);
  try {
    let now = 1_000;
    const pool = createAuthPool({ tokens: ["a", "b"], clock: () => now });
    pool.onError("a", { cooldownMs: 60_000 }); // a 冷却
    const s1 = await pool.acquireSlot({ timeoutMs: 100 });
    assert.equal(s1.token, "b");
    const s2 = await pool.acquireSlot({ timeoutMs: 30 }); // b 也忙、a 冷却
    assert.equal(s2, null);
    s1.release();
  } finally {
    clearInterval(keep);
  }
});

test("acquireSlot: maxConcurrentPerToken=2 时同 token 允许 2 在途", async () => {
  const keep = setInterval(() => {}, 10);
  try {
    const pool = createAuthPool({ tokens: ["a"], clock: () => 1_000, maxConcurrentPerToken: 2 });
    const s1 = await pool.acquireSlot({ timeoutMs: 100 });
    const s2 = await pool.acquireSlot({ timeoutMs: 100 });
    assert.equal(s1.token, "a");
    assert.equal(s2.token, "a"); // 同 token 2 在途放行
    const s3 = await pool.acquireSlot({ timeoutMs: 30 });
    assert.equal(s3, null); // 第 3 个排队超时
    s1.release();
    s2.release();
  } finally {
    clearInterval(keep);
  }
});

test("acquireSlot: 失败释放+冷却组合 — release 后等待者跳过冷却号", async () => {
  const pool = createAuthPool({ tokens: ["a", "b"], clock: () => 1_000 });
  const s1 = await pool.acquireSlot({ timeoutMs: 100 }); // a
  let acquired = null;
  const pending = pool.acquireSlot({ timeoutMs: 1_000 }).then((s) => (acquired = s));
  await new Promise((r) => setTimeout(r, 20));
  s1.release();
  pool.onError("a", { cooldownMs: 60_000 }); // a 释放后进冷却
  await pending;
  assert.equal(acquired.token, "b"); // 唤醒后跳过冷却的 a
  acquired.release();
});

// ---------- T2 runDeepseekChat 集成 ----------
const SESSION_CREATE = "/api/v0/chat_session/create";
const POW = "/api/v0/chat/create_pow_challenge";
const COMPLETION = "/api/v0/chat/completion";
const SESSION_DELETE = "/api/v0/chat_session/delete";

function okRoutes({ onCompletion, onSessionCreate, hang } = {}) {
  const calls = [];
  const routes = {
    [SESSION_CREATE]: () => {
      calls.push("create");
      if (onSessionCreate) return onSessionCreate();
      return jsonOk({ code: 0, data: { biz_code: 0, biz_data: { id: "s-" + calls.length } } });
    },
    [POW]: () => {
      calls.push("pow");
      return jsonOk({ code: 0, data: { biz_code: 0, biz_data: { challenge: CHALLENGE } } });
    },
    [COMPLETION]: () => {
      calls.push("completion");
      if (hang) {
        const hung = hang();
        if (hung) return hung; // hang 工厂返回 null = 不挂起，走下方正常 SSE
      }
      return new Response('data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"hi"}]}}}\n\n', { status: 200, headers: { "Content-Type": "text/event-stream" } });
    },
    [SESSION_DELETE]: () => {
      calls.push("delete");
      return jsonOk({ code: 0 });
    },
  };
  const fetchImpl = async (url, opts = {}) => {
    const path = String(url).replace(BASE, "").split("?")[0];
    const handler = routes[path];
    if (!handler) return new Response("no route", { status: 404 });
    return handler(opts);
  };
  return { calls, fetchImpl };
}

test("runDeepseekChat: 单 token 两并发 — 第二个请求等第一个完成才开始", async () => {
  const pool = createAuthPool({ tokens: ["tk"], clock: () => 1_000 });
  let releaseFirst = null;
  let hangUsed = false;
  const { calls, fetchImpl } = okRoutes({ hang: () => {
    if (hangUsed) return null; // 只有第一个请求挂起，第二个放行走正常 SSE
    hangUsed = true;
    return new Promise((resolve) => { releaseFirst = () => resolve(new Response('data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"x"}]}}}\n\n', { status: 200, headers: { "Content-Type": "text/event-stream" } })); });
  } });

  const body = { model: "deepseek/chat-free", messages: [{ role: "user", content: "hi" }], stream: false };
  const p1 = runDeepseekChat({ body, authPool: pool, fetchImpl, baseUrl: BASE, maxAuthRetries: 1 });
  await new Promise((r) => setTimeout(r, 30));
  const p2 = runDeepseekChat({ body, authPool: pool, fetchImpl, baseUrl: BASE, maxAuthRetries: 1 }).catch(() => "failed");
  await new Promise((r) => setTimeout(r, 30));

  const completionsBeforeRelease = calls.filter((c) => c === "create").length;
  assert.equal(completionsBeforeRelease, 1); // 第二个请求未打上游（排队证据）

  releaseFirst();
  await p1;
  await p2;
  assert.ok(calls.filter((c) => c === "create").length >= 2); // 释放后第二个请求放行
});

test("runDeepseekChat: 流式 cleanup 释放槽位 — cleanup 后下一个请求立即放行", async () => {
  const pool = createAuthPool({ tokens: ["tk"], clock: () => 1_000 });
  const { calls, fetchImpl } = okRoutes({});
  const body = { model: "deepseek/chat-free", messages: [{ role: "user", content: "hi" }], stream: true };
  const out = await runDeepseekChat({ body, authPool: pool, fetchImpl, baseUrl: BASE, maxAuthRetries: 1 });
  assert.equal(out.kind, "stream");

  let slotBusyBeforeCleanup = true;
  const probe = pool.acquireSlot({ timeoutMs: 30 }).then((s) => { slotBusyBeforeCleanup = Boolean(s); if (s) s.release(); });
  await probe;
  assert.equal(slotBusyBeforeCleanup, false); // 流未结束，槽位仍被持有

  await out.cleanup(); // 流结束（上层 done/error/cancel 调用点）
  const s = await pool.acquireSlot({ timeoutMs: 30 });
  assert.ok(s); // cleanup 释放后可立即获取
  if (s) s.release();
});

test("runDeepseekChat: 聚合失败立即释放槽位", async () => {
  const pool = createAuthPool({ tokens: ["tk"], clock: () => 1_000 });
  const { fetchImpl } = okRoutes({ onSessionCreate: () => new Response("boom", { status: 500 }) });
  const body = { model: "deepseek/chat-free", messages: [{ role: "user", content: "hi" }], stream: false };
  await assert.rejects(() => runDeepseekChat({ body, authPool: pool, fetchImpl, baseUrl: BASE, maxAuthRetries: 0 }));
  const s = await pool.acquireSlot({ timeoutMs: 30 });
  assert.ok(s); // 失败后槽位已释放
  if (s) s.release();
});

test("runDeepseekChat: rotateAuth 失败释放并冷却，下一 attempt 用别的号", async () => {
  const pool = createAuthPool({ tokens: ["tk1", "tk2"], clock: () => 1_000 });
  const seen = [];
  const routes = {
    [SESSION_CREATE]: ({ headers }) => {
      seen.push(headers.Authorization);
      return new Response("err", { status: 403 });
    },
    [POW]: () => jsonOk({ code: 0, data: { biz_code: 0, biz_data: { challenge: CHALLENGE } } }),
  };
  const fetchImpl = async (url, opts = {}) => {
    const path = String(url).replace(BASE, "").split("?")[0];
    return routes[path] ? routes[path](opts) : new Response("no route", { status: 404 });
  };
  const body = { model: "deepseek/chat-free", messages: [{ role: "user", content: "hi" }], stream: false };
  // maxAuthRetries=2：attempt0 用 tk1 失败（403 rotate）→ attempt1 用 tk2
  await assert.rejects(() => runDeepseekChat({ body, authPool: pool, fetchImpl, baseUrl: BASE, maxAuthRetries: 2 }), /会话创建失败/);
  assert.ok(seen.some((a) => a === "Bearer tk1"));
  assert.ok(seen.some((a) => a === "Bearer tk2")); // 轮换到第二个号
  // 双号全部失败进冷却 → 探针排队超时 null（闸门与冷却正确联动；30s 后恢复由 antiban 测试覆盖）
  const keep = setInterval(() => {}, 10);
  try {
    const s = await pool.acquireSlot({ timeoutMs: 30 });
    assert.equal(s, null);
  } finally {
    clearInterval(keep);
  }
});
