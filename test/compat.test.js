import test from "node:test";
import assert from "node:assert/strict";
import { compatFetch, timeoutSignal, clone, uuid, getUndici } from "../src/compat.js";

test("uuid：两次不同且形如 UUID", () => {
  const a = uuid();
  const b = uuid();
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("timeoutSignal：到期 aborted", async () => {
  const s = timeoutSignal(30);
  assert.equal(s.aborted, false);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(s.aborted, true);
});

test("clone：深拷贝不共享引用", () => {
  const src = { a: { b: [1, 2] } };
  const out = clone(src);
  assert.deepEqual(out, src);
  out.a.b.push(3);
  assert.deepEqual(src.a.b, [1, 2]);
});

test("clone：非对象原样返回", () => {
  assert.equal(clone(null), null);
  assert.equal(clone(5), 5);
  assert.equal(clone("x"), "x");
});

test("compatFetch/getUndici：可用且是函数", async () => {
  assert.equal(typeof compatFetch, "function");
  assert.equal(typeof getUndici().fetch, "function");
  const res = await compatFetch("http://127.0.0.1:9/health", { signal: timeoutSignal(500) }).catch((e) => e);
  assert.ok(res);
});
