// SDK 通道 headers 超时防护：doStream 裸 await 曾因上游连接半死永不 resolve
//（cline-cline-free-muse-spark 17:48:24 悬空 27min+，无 upstream-done/error/result）。
// 锁三点：超时必抛 / env=0 可关 / abortSignal 传递给 doStream。回归：正常流不受影响。
import { test } from "node:test";
import assert from "node:assert/strict";
import { attemptOnceSdk, withHeadersTimeout } from "../src/upstream-engine/sdk/attempt.js";

async function withEnv(env, fn) {
  const prev = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; process.env[k] = env[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

const BASE = "https://api.cline.bot/api/v1/chat/completions";
const HEADERS = { Authorization: "Bearer x" };
const BODY = { model: "muse-spark-1.3-contributor", stream: true, messages: [{ role: "user", content: "hi" }] };

function sseResponse() {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) { c.enqueue(enc.encode("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n")); c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("withHeadersTimeout: 超时抛错且清定时器（不挂进程）", async () => {
  await assert.rejects(
    withHeadersTimeout(new Promise(() => {}), 20, () => Object.assign(new Error("sdk-channel: headers timeout"), { name: "HeadersTimeoutError" })),
    /headers timeout/,
  );
});

test("withHeadersTimeout: ms<=0 关闭（挂起 promise 原样返回）", async () => {
  let settled = false;
  const p = withHeadersTimeout(new Promise((r) => setTimeout(() => { settled = true; r("late"); }, 40)), 0, () => new Error("never"));
  const v = await Promise.race([p.then(() => "done"), new Promise((r) => setTimeout(() => r("pending"), 15))]);
  assert.equal(v, "pending", "0 应不设超时");
  await p;
  assert.equal(settled, true);
});

test("withHeadersTimeout: promise 先赢不触发 unhandled rejection", async () => {
  const r = await withHeadersTimeout(Promise.resolve("fast"), 20, () => new Error("boom"));
  assert.equal(r, "fast");
  await new Promise((r2) => setTimeout(r2, 40)); // 给 boom 路径留抛出窗口
});

test("attemptOnceSdk: doStream 永挂 → headers 超时抛错（不 retries 放大文案）", async () => {
  await withEnv({ MSLXDFF_SDK_HEADERS_TIMEOUT_MS: "50" }, async () => {
    const seen = { abortSignal: null };
    await assert.rejects(
      attemptOnceSdk({
        url: BASE, body: BODY, headers: HEADERS,
        sdkLoader: async () => ({
          createOpenAICompatible: () => ({
            chatModel: () => ({
              doStream: async (params) => { seen.abortSignal = params.abortSignal; return new Promise(() => {}); },
            }),
          }),
        }),
      }),
      (e) => {
        assert.match(e.message, /headers/i);
        assert.doesNotMatch(e.message, /timed out/i, "不得含 'timed out'（cline runChat 靠该文案重试，会放大 3 倍挂死）");
        return true;
      },
    );
    assert.ok(seen.abortSignal instanceof AbortSignal, "doStream 应收到 abortSignal");
  });
});

test("attemptOnceSdk: env=0 关闭超时 → 挂起保持挂起（不误杀慢模型握手）", async () => {
  await withEnv({ MSLXDFF_SDK_HEADERS_TIMEOUT_MS: "0" }, async () => {
    const p = attemptOnceSdk({
      url: BASE, body: BODY, headers: HEADERS,
      sdkLoader: async () => ({
        createOpenAICompatible: () => ({
          chatModel: () => ({ doStream: async () => new Promise(() => {}) }),
        }),
      }),
    });
    const v = await Promise.race([p.then(() => "done"), new Promise((r) => setTimeout(() => r("pending"), 60))]);
    assert.equal(v, "pending");
  });
});

test("attemptOnceSdk: 正常流不受超时影响（SSE Response 原样返回）", async () => {
  await withEnv({ MSLXDFF_SDK_HEADERS_TIMEOUT_MS: "5000" }, async () => {
    const res = await attemptOnceSdk({
      url: BASE, body: BODY, headers: HEADERS,
      sdkLoader: async () => ({
        createOpenAICompatible: () => ({
          chatModel: () => ({ doStream: async () => ({ stream: (async function* () { yield { type: "text-delta", id: "1", text: "ok" }; yield { type: "finish", id: "1", finishReason: "stop" }; })() }) }),
        }),
      }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
  });
});

test("attemptOnceSdk: 429 错误映射回归（超时包裹不破坏既有分支）", async () => {
  await withEnv({ MSLXDFF_SDK_HEADERS_TIMEOUT_MS: "5000" }, async () => {
    const res = await attemptOnceSdk({
      url: BASE, body: BODY, headers: HEADERS,
      sdkLoader: async () => ({
        createOpenAICompatible: () => ({
          chatModel: () => ({
            doStream: async () => { const e = new Error("rate limited"); e.statusCode = 429; e.responseBody = "{\"error\":\"429\"}"; throw e; },
          }),
        }),
      }),
    });
    assert.equal(res.status, 429);
    assert.match(String(res.headers.get("content-type")), /application\/json/);
  });
});
