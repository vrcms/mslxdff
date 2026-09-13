import { test } from "node:test";
import assert from "node:assert/strict";
import { streamResponseFromParts } from "../src/upstream-engine/sdk/attempt.js";

// 模拟 AI SDK 的 res.stream：async iterable（挂起不产出）+ 可注入的 cancel。
// 真实场景：客户端断开 → Response.body.cancel() → 此处 parts 仍被 start 的
// for-await 锁定 → parts.cancel() 抛 ERR_INVALID_STATE 或返回 rejected promise。
function hangingParts(cancelImpl) {
  let pendingResolve = null;
  const iterator = {
    next: () => new Promise((resolve) => { pendingResolve = resolve; }),
    return: () => Promise.resolve({ done: true }),
  };
  return {
    [Symbol.asyncIterator]: () => iterator,
    cancel: cancelImpl,
    _release: (v = { done: true, value: undefined }) => pendingResolve?.(v),
  };
}

test("streamResponseFromParts：parts.cancel 返回 rejected promise 不产生 unhandled rejection（v0.1.111 崩溃回归）", async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const parts = hangingParts(() => {
      const e = new Error("Invalid state: ReadableStream is locked");
      e.code = "ERR_INVALID_STATE";
      return Promise.reject(e);
    });
    const res = streamResponseFromParts(parts);
    await res.body.cancel();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(unhandled.length, 0, "cancel 的 rejection 必须被吞掉，否则进程崩溃");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("streamResponseFromParts：parts.cancel 同步抛错被吞", async () => {
  const parts = hangingParts(() => { throw new Error("Invalid state: ReadableStream is locked"); });
  const res = streamResponseFromParts(parts);
  await res.body.cancel();
});

test("streamResponseFromParts：取消后迭代恢复也不再 enqueue", async () => {
  let cancelCalls = 0;
  const parts = hangingParts(() => { cancelCalls++; return Promise.resolve(); });
  const res = streamResponseFromParts(parts);
  await res.body.cancel();
  parts._release({ done: true, value: undefined });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cancelCalls, 1);
});
