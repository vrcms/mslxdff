import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveIncludeOpencode } from "../src/bench/via.js";

describe("bench/via confirm", () => {
  it("无 --include-opencode 直接 false", async () => {
    const r = await resolveIncludeOpencode({ includeOpencode: false, isTTY: true, confirmFn: async () => true });
    assert.equal(r, false);
  });
  it("TTY y 放行", async () => {
    const r = await resolveIncludeOpencode({ includeOpencode: true, isTTY: true, confirmFn: async () => true });
    assert.equal(r, true);
  });
  it("TTY n 回落", async () => {
    const r = await resolveIncludeOpencode({ includeOpencode: true, isTTY: true, confirmFn: async () => false });
    assert.equal(r, false);
  });
  it("非 TTY 直接回落不阻塞", async () => {
    let called = 0;
    const confirmFn = async () => { called++; return true; };
    const r = await resolveIncludeOpencode({ includeOpencode: true, isTTY: false, confirmFn });
    assert.equal(r, false);
    assert.equal(called, 0);
  });
});
