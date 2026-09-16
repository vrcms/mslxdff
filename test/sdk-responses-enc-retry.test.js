import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { attemptOnceResponsesSdk, isEncryptedCallerError } from "../src/upstream-engine/sdk/responses.js";

const ENC_400_BODY = JSON.stringify({
  model: "muse-spark-1.3-contributor-free",
  error: { param: null, type: "invalid_request_error", message: "Error from provider (Console): Upstream request failed: [invalid_request_error] reasoning `encrypted_content` was not issued to this caller" },
});

const msgBody = (extra = {}) => ({
  model: "muse-spark-1.3-contributor-free",
  stream: true,
  messages: [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello", reasoning_items: [{ id: "rs_1", encrypted_content: "ENC1", summary: [{ text: "想了" }] }], ...extra },
    { role: "user", content: "again" },
  ],
});

// seq: 元素为 "ok" 或 {status, body}；doStream 按调用次序响应，记录每次 prompt。
function mkSdk(seq) {
  const calls = [];
  const sdkLoader = async () => ({
    createOpenAI: () => ({
      responses: () => ({
        doStream: async (args) => {
          calls.push(args);
          const step = seq[Math.min(calls.length - 1, seq.length - 1)];
          if (step === "ok") return { stream: (async function* () {})() };
          const e = new Error("APICallError");
          e.statusCode = step.status;
          e.responseBody = step.body;
          throw e;
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

const reasoningParts = (call) =>
  (call.prompt || []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === "reasoning");

describe("responses 加密态跨 caller 400 降级", () => {
  test("识别特征错误文案", () => {
    assert.equal(isEncryptedCallerError(ENC_400_BODY), true);
    assert.equal(isEncryptedCallerError('{"error":{"message":"other"}}'), false);
    assert.equal(isEncryptedCallerError(""), false);
    assert.equal(isEncryptedCallerError(null), false);
  });

  test("400(encrypted) → 剥态重试成功：第二次 prompt 不含加密态，返回 200", async () => {
    const sdk = mkSdk([{ status: 400, body: ENC_400_BODY }, "ok"]);
    const res = await attemptOnceResponsesSdk(opts(sdk));
    assert.equal(res.status, 200);
    assert.equal(sdk.calls.length, 2, "应重试一次");
    const first = reasoningParts(sdk.calls[0]);
    assert.equal(first[0].providerOptions.openai.reasoningEncryptedContent, "ENC1", "首试带加密态");
    const second = reasoningParts(sdk.calls[1]);
    assert.equal(second.length, 1, "重试保留摘要文本");
    assert.equal(second[0].text, "想了");
    assert.equal(second[0].providerOptions, undefined, "重试不得再带加密态");
  });

  test("400(非 encrypted) → 不重试，原样返回 400", async () => {
    const sdk = mkSdk([{ status: 400, body: '{"error":{"message":"bad tool sequence"}}' }]);
    const res = await attemptOnceResponsesSdk(opts(sdk));
    assert.equal(res.status, 400);
    assert.equal(sdk.calls.length, 1);
  });

  test("剥态重试仍 400 → 返回第二次的 400（交上层转组员）", async () => {
    const sdk = mkSdk([{ status: 400, body: ENC_400_BODY }, { status: 400, body: '{"error":{"message":"still failing"}}' }]);
    const res = await attemptOnceResponsesSdk(opts(sdk));
    assert.equal(res.status, 400);
    assert.equal(sdk.calls.length, 2);
    assert.match(await res.text(), /still failing/);
  });
});
