import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveRetry, shouldRetry, backoffDelay } from "../src/transport/retry.js";

describe("transport/retry - 纯函数决策", () => {
  const cfg = {
    network: { attempts: 2, delayMs: 300 },
    429: { attempts: 1, delayMs: 100 },
    502: { attempts: 1, delayMs: 100 },
    503: { attempts: 1, delayMs: 100 },
    504: { attempts: 1, delayMs: 100 },
  };

  it("network 第0次应重试，delay 300", () => {
    const r = resolveRetry("network", 0, cfg);
    assert.equal(r.shouldRetry, true);
    assert.equal(r.delayMs, 300);
  });
  it("network 第1次应重试，指数退避 600", () => {
    const r = resolveRetry("network", 1, cfg);
    assert.equal(r.shouldRetry, true);
    assert.equal(r.delayMs, 600); // 300 * 2^1
  });
  it("network 第2次超限不重试", () => {
    const r = resolveRetry("network", 2, cfg);
    assert.equal(r.shouldRetry, false);
  });
  it("429 第0次应重试 100", () => {
    const r = resolveRetry(429, 0, cfg);
    assert.equal(r.shouldRetry, true);
    assert.equal(r.delayMs, 100);
  });
  it("429 第1次超限不重试", () => {
    const r = resolveRetry(429, 1, cfg);
    assert.equal(r.shouldRetry, false);
  });
  it("502 同 429", () => {
    assert.equal(resolveRetry(502, 0, cfg).shouldRetry, true);
    assert.equal(resolveRetry(502, 1, cfg).shouldRetry, false);
  });
  it("200 不重试", () => {
    assert.equal(resolveRetry(200, 0, cfg).shouldRetry, false);
  });
  it("未知 418 不重试", () => {
    assert.equal(resolveRetry(418, 0, cfg).shouldRetry, false);
  });
  it("shouldRetry 便捷包装", () => {
    assert.equal(shouldRetry("network", 0, cfg), true);
    assert.equal(shouldRetry(429, 1, cfg), false);
  });
  it("backoffDelay 计算", () => {
    assert.equal(backoffDelay(100, 0), 100);
    assert.equal(backoffDelay(100, 1), 200);
    assert.equal(backoffDelay(100, 2), 400);
  });
});
