import assert from "node:assert/strict";
import test from "node:test";

import { netRetry } from "../src/providers/deepseek/pow.js";

test("netRetry: passes through on first success", async () => {
  let calls = 0;
  const out = await netRetry(async () => { calls++; return "ok"; });
  assert.equal(out, "ok");
  assert.equal(calls, 1);
});

test("netRetry: retries network errors then succeeds", async () => {
  let calls = 0;
  const out = await netRetry(async () => {
    calls++;
    if (calls === 1) throw new Error("fetch failed");
    return "ok";
  }, { delayMs: 1 });
  assert.equal(out, "ok");
  assert.equal(calls, 2);
});

test("netRetry: exhausts attempts and throws last error", async () => {
  let calls = 0;
  await assert.rejects(
    () => netRetry(async () => { calls++; throw new Error("This operation was aborted"); }, { attempts: 2, delayMs: 1 }),
    /aborted/
  );
  assert.equal(calls, 3); // 首次 + 2 次重试
});

test("netRetry: does not retry business errors", async () => {
  let calls = 0;
  await assert.rejects(
    () => netRetry(async () => { calls++; throw new Error("DeepSeek 登录失败: 账号或密码错误"); }),
    /账号或密码错误/
  );
  assert.equal(calls, 1);
});

test("netRetry: detects cause.code network errors", async () => {
  let calls = 0;
  const out = await netRetry(async () => {
    calls++;
    if (calls === 1) {
      const e = new Error("request failed");
      e.cause = { code: "ECONNRESET" };
      throw e;
    }
    return "ok";
  }, { delayMs: 1 });
  assert.equal(out, "ok");
  assert.equal(calls, 2);
});
