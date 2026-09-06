import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { sha3_256Fips202Reference, deepSeekHashV1, findPowNonce } from "../src/providers/deepseek/hash.js";

test("FIPS 202 reference matches node:crypto sha3-256 across block boundaries", () => {
  const inputs = [
    "",
    "hello world",
    "a".repeat(135),
    "a".repeat(136),
    "a".repeat(137),
    "a".repeat(272),
    "b".repeat(500),
    "中文输入测试 🎉 emoji",
  ];
  for (const input of inputs) {
    const expected = createHash("sha3-256").update(input, "utf8").digest("hex");
    assert.equal(sha3_256Fips202Reference(input), expected, `mismatch for len=${input.length}`);
  }
});

test("deepSeekHashV1 differs from standard SHA3-256 (23 rounds vs 24)", () => {
  const input = "testsalt_1757000000_12345";
  const std = createHash("sha3-256").update(input, "utf8").digest("hex");
  const ds = deepSeekHashV1(input);
  assert.notEqual(ds, std);
  assert.match(ds, /^[a-f0-9]{64}$/);
});

test("deepSeekHashV1 is deterministic and input-sensitive", () => {
  const a = deepSeekHashV1("prefix_a_999");
  const b = deepSeekHashV1("prefix_a_999");
  const c = deepSeekHashV1("prefix_a_1000");
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("findPowNonce recovers a known nonce (self-consistent)", () => {
  const prefix = "salt_1757000000_";
  const nonce = 12345;
  const challenge = deepSeekHashV1(`${prefix}${nonce}`);
  assert.equal(findPowNonce(prefix, challenge, 144000), nonce);
});

test("findPowNonce returns -1 when answer not in space", () => {
  // nonce=200000 在 difficulty=1000 的空间外 → 找不到
  const prefix = "salt_1_";
  const challenge = deepSeekHashV1(`${prefix}200000`);
  assert.equal(findPowNonce(prefix, challenge, 1000), -1);
});

test("findPowNonce rejects malformed challenge", () => {
  assert.throws(() => findPowNonce("p_", "not-hex", 100), TypeError);
  assert.throws(() => findPowNonce("p_", "5d41402abc4b2a76b9719d911017c59", 100), TypeError);
  assert.throws(() => findPowNonce("p_", `${"g".repeat(64)}`, 100), TypeError);
});

test("findPowNonce rejects invalid difficulty", () => {
  const challenge = "5".repeat(64);
  assert.throws(() => findPowNonce("p_", challenge, 0), RangeError);
  assert.throws(() => findPowNonce("p_", challenge, 250_001), RangeError);
  assert.throws(() => findPowNonce("p_", challenge, 1.5), RangeError);
});

test("findPowNonce finds nonce 0 and difficulty boundary", () => {
  const prefix = "s_";
  assert.equal(findPowNonce(prefix, deepSeekHashV1(`${prefix}0`), 10), 0);
  const boundary = 999;
  assert.equal(findPowNonce(prefix, deepSeekHashV1(`${prefix}${boundary}`), 1000), boundary);
});

const wasmPath = fileURLToPath(new URL("../test/fixtures/sha3_wasm_bg.wasm", import.meta.url));

test("official wasm_solve recovers the nonce our hash constructs (cross-validation)", { skip: !existsSync(wasmPath) && "fixture missing" }, async () => {
  const bytes = readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(bytes, { wbg: {} });
  const w = instance.exports;
  const enc = new TextEncoder();

  function passString(s) {
    const b = enc.encode(s);
    const ptr = w.__wbindgen_export_0(b.length, 1) >>> 0;
    new Uint8Array(w.memory.buffer).set(b, ptr);
    return [ptr, b.length];
  }

  function wasmSolve(challenge, prefix, difficulty) {
    const retptr = w.__wbindgen_add_to_stack_pointer(-16);
    try {
      const [cPtr, cLen] = passString(challenge);
      const [pPtr, pLen] = passString(prefix);
      w.wasm_solve(retptr, cPtr, cLen, pPtr, pLen, difficulty);
      const view = new DataView(w.memory.buffer);
      const status = view.getInt32(retptr, true);
      const answer = view.getFloat64(retptr + 8, true);
      return { status, answer };
    } finally {
      w.__wbindgen_add_to_stack_pointer(16);
    }
  }

  const prefix = "fixturesalt_1757000000_";
  const expectedNonce = 4242;
  const challenge = deepSeekHashV1(`${prefix}${expectedNonce}`);

  const t0 = performance.now();
  const { status, answer } = wasmSolve(challenge, prefix, 144000);
  const ms = performance.now() - t0;

  assert.equal(status, 1, `wasm_solve status=${status}`);
  assert.equal(Math.round(answer), expectedNonce);
  assert.ok(ms < 5000, `wasm solve took ${ms.toFixed(0)}ms`);

  // 反向：JS 求解器还原 wasm 视角的同一 challenge
  assert.equal(findPowNonce(prefix, challenge, 144000), expectedNonce);
});

test("pure JS solver handles difficulty=144000 within 3s", () => {
  const prefix = "perfsalt_1757000000_";
  const challenge = deepSeekHashV1(`${prefix}77777`);
  const t0 = performance.now();
  const nonce = findPowNonce(prefix, challenge, 144000);
  const ms = performance.now() - t0;
  assert.equal(nonce, 77777);
  assert.ok(ms < 3000, `solve took ${ms.toFixed(0)}ms`);
});
