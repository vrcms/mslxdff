// qwenwork 单测：provider 门面（注入假 fetch，不碰网络）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createQwenworkProvider } from "../src/providers/qwenwork/index.js";
import { accountFromBlob } from "../src/providers/qwenwork/account-store.js";

const BLOB = JSON.stringify({ device_token: "dt-fake", refresh_token: "drt-fake" });

function sseBody(frames) {
  const enc = new TextEncoder();
  const chunks = frames.map((f) => enc.encode(`data: ${f}\n\n`));
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < chunks.length) c.enqueue(chunks[i++]);
      else c.close();
    },
  });
}

function chunkFrame(content) {
  return JSON.stringify({ id: "c1", model: "pool", choices: [{ index: 0, delta: { role: "assistant", content } }] });
}

test("accountFromBlob: 双形状兼容", () => {
  assert.equal(accountFromBlob(BLOB)?.accessToken, "dt-fake");
  assert.equal(accountFromBlob(JSON.stringify({ accessToken: "x" }))?.accessToken, "x");
  assert.equal(accountFromBlob("not-json"), null);
  assert.equal(accountFromBlob(JSON.stringify({})), null);
});

test("无号 → 401 提示 login（MSLXDFF_TEST=1 下与真实 state 隔离）", async () => {
  // 单测进程与真实 state/auth 目录隔离：无号就是无号，不得读出用户真号（曾读出真号打现网）
  process.env.MSLXDFF_TEST = "1";
  try {
    const p = createQwenworkProvider({ apiKeys: [] });
    const res = await p.chat({ model: "qwenwork/flash", messages: [{ role: "user", content: "hi" }], stream: false });
    assert.equal(res.status, 401);
    const j = await res.json();
    assert.match(j.error.message, /login/);
  } finally {
    delete process.env.MSLXDFF_TEST;
  }
});

test("非流式 200 → completion.model 回写请求名", async () => {
  const fetchImpl = async () => new Response(sseBody([chunkFrame("Hello")]), { status: 200 });
  const p = createQwenworkProvider({
    apiKeys: [BLOB],
    fetchImpl: async (url, opts) => {
      if (String(url).includes("userinfo")) {
        return new Response(JSON.stringify({ id: "uid-1", name: "n", email: "e" }), { status: 200 });
      }
      return fetchImpl(url, opts);
    },
  });
  const res = await p.chat({ model: "qwenwork/flash", messages: [{ role: "user", content: "hi" }], stream: false });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.model, "flash");
  assert.equal(j.choices[0].message.content, "Hello");
});

test("401 + 有 refresh → 刷新后重试（同一号）", async () => {
  let chatCalls = 0;
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("userinfo")) return new Response(JSON.stringify({ id: "uid-9", name: "n" }), { status: 200 });
    if (u.includes("deviceToken/refresh")) {
      return new Response(JSON.stringify({ token: "dt-new", refresh_token: "drt-new" }), { status: 200 });
    }
    chatCalls++;
    if (chatCalls === 1) return new Response("unauthorized", { status: 401 });
    return new Response(sseBody([chunkFrame("retry-ok")]), { status: 200 });
  };
  const p = createQwenworkProvider({ apiKeys: [BLOB], fetchImpl });
  const res = await p.chat({ model: "pro", messages: [{ role: "user", content: "hi" }], stream: false });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.choices[0].message.content, "retry-ok");
  assert.equal(chatCalls, 2);
});

test("额度耗尽 → 长冷却 + 429 quota_exhausted", async () => {
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("userinfo")) return new Response(JSON.stringify({ id: "uid-q", name: "n" }), { status: 200 });
    return new Response("credits exhausted", { status: 429 });
  };
  const p = createQwenworkProvider({ apiKeys: [BLOB], fetchImpl });
  const res = await p.chat({ model: "flash", messages: [{ role: "user", content: "hi" }], stream: false });
  assert.equal(res.status, 429);
  const j = await res.json();
  assert.equal(j.error.type, "quota_exhausted");
});

test("listModels: 上游失败时用 3 个快照兜底", async () => {
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("userinfo")) return new Response(JSON.stringify({ id: "uid-m", name: "n" }), { status: 200 });
    if (u.includes("model/list")) return new Response("bad", { status: 500 });
    return new Response("bad", { status: 500 });
  };
  const p = createQwenworkProvider({ apiKeys: [BLOB], fetchImpl });
  const list = await p.listModels();
  assert.equal(list.length, 3);
  assert.ok(list.every((m) => m.id.startsWith("qwenwork/")));
});
