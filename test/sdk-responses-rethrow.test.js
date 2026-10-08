import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { attemptOnceResponsesSdk } from "../src/upstream-engine/sdk/responses.js";

// 回归锚：responses 通道 catch 判 mapped=null（非 HTTP 错误）后必须 rethrow，
// 不得掉到 streamResponseFromParts(res.stream) 抛 TypeError。
// 起因：2026-10-07 muse-spark 连续 502，errors.log 记
// "Cannot read properties of undefined (reading 'stream')"（req=muxem672-7wlc）。

const msgBody = () => ({
  model: "muse-spark-1.3-contributor-free",
  stream: true,
  messages: [{ role: "user", content: "hi" }],
});

// makeError 每次调用返回一个 Error：无 statusCode 即"非 HTTP 类错误"。
function mkSdk(makeError) {
  const calls = [];
  const sdkLoader = async () => ({
    createOpenAI: () => ({
      responses: () => ({
        doStream: async (args) => {
          calls.push(args);
          throw makeError();
        },
      }),
    }),
  });
  return { sdkLoader, calls };
}

const opts = (sdk) => ({
  url: "https://opencode.ai/zen/v1/responses",
  body: msgBody(),
  headers: { authorization: "Bearer public" },
  sdkLoader: sdk.sdkLoader,
  fetchImpl: async () => new Response(""),
});

describe("responses 通道非 HTTP 错误必须 rethrow", () => {
  test("无 statusCode 的网络错误 → 抛原始错误本身，不是 TypeError", async () => {
    const netErr = new Error("fetch failed");
    const sdk = mkSdk(() => netErr);
    let caught = null;
    try {
      await attemptOnceResponsesSdk(opts(sdk));
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "必须抛出，不得静默掉进 res.stream");
    assert.equal(caught, netErr, "必须 rethrow 原始错误，保留 message 供上层 peer/failover 判因");
    assert.notEqual(caught.constructor.name, "TypeError", "不得再抛 Cannot read properties of undefined");
  });

  test("HTTP 429 仍映射为 Response（不回归既有映射路径）", async () => {
    const sdk = mkSdk(() => {
      const e = new Error("rate limited");
      e.statusCode = 429;
      e.responseBody = '{"error":{"message":"slow down"}}';
      return e;
    });
    const res = await attemptOnceResponsesSdk(opts(sdk));
    assert.equal(res.status, 429);
    assert.match(await res.text(), /slow down/);
  });

  test("e.status（非 statusCode）也走映射，不误触 rethrow", async () => {
    const sdk = mkSdk(() => {
      const e = new Error("upstream 500");
      e.status = 500;
      return e;
    });
    const res = await attemptOnceResponsesSdk(opts(sdk));
    assert.equal(res.status, 500);
  });
});
