import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeyRing, DEFAULT_COOLDOWN_MS } from "../src/providers/keyring.js";

let t = 0;
const now = () => t;

test("keyring: round-robin cycles keys in order", () => {
  t = 0;
  const ring = createKeyRing(["a", "b", "c"], { now });
  assert.equal(ring.next(), "a");
  assert.equal(ring.next(), "b");
  assert.equal(ring.next(), "c");
  assert.equal(ring.next(), "a");
});

test("keyring: onError cools one key, rotation skips it", () => {
  t = 0;
  const ring = createKeyRing(["a", "b"], { cooldownMs: 30_000, now });
  assert.equal(ring.next(), "a");
  ring.onError("a");
  // b 可用
  assert.equal(ring.next(), "b");
  // a 在冷却内，仍跳过
  t = 10_000;
  assert.equal(ring.next(), "b");
  // b 出错后，双 key 冷却 → null
  ring.onError("b");
  assert.equal(ring.next(), null);
});

test("keyring: cooldown expiry re-enables a key", () => {
  t = 0;
  const ring = createKeyRing(["a", "b"], { cooldownMs: 30_000, now });
  ring.next();
  ring.onError("a");
  t = 29_999;
  assert.equal(ring.next(), "b");
  t = 30_001;
  assert.equal(ring.next(), "a", "a 冷却期满重新可用");
});

test("keyring: all keys cooled => next returns null (provider unavailable)", () => {
  t = 0;
  const ring = createKeyRing(["a", "b"], { cooldownMs: 30_000, now });
  ring.onError("a");
  ring.onError("b");
  assert.equal(ring.next(), null);
  assert.equal(ring.available(), 0);
});

test("keyring: empty and deduped keys", () => {
  t = 0;
  assert.equal(createKeyRing([], { now }).next(), null);
  const ring = createKeyRing(["a", "a", "", "b", " "], { now });
  assert.equal(ring.size, 2);
});

test("keyring: default cooldown is 30s", () => {
  assert.equal(DEFAULT_COOLDOWN_MS, 30_000);
});