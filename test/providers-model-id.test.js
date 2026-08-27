import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { splitModelId, joinModelId, normalizeProviderId, DEFAULT_PROVIDER } from "../src/providers/model-id.js";

describe("model-id prefix parsing", () => {
  test("bare id resolves to default provider with raw unchanged", () => {
    assert.deepEqual(splitModelId("deepseek-v4-flash-free"), { provider: "opencode", raw: "deepseek-v4-flash-free", prefixed: false });
    assert.deepEqual(splitModelId("big-pickle"), { provider: "opencode", raw: "big-pickle", prefixed: false });
  });

  test("prefixed id resolves to the named provider and strips prefix", () => {
    assert.deepEqual(splitModelId("openrouter/google/gemma-4-26b-a4b-it:free", ["openrouter"]), {
      provider: "openrouter",
      raw: "google/gemma-4-26b-a4b-it:free",
      prefixed: true,
    });
  });

  test("oc/ legacy prefix maps to opencode", () => {
    assert.deepEqual(splitModelId("oc/deepseek-v4-flash-free", ["openrouter"]), {
      provider: "opencode",
      raw: "deepseek-v4-flash-free",
      prefixed: true,
    });
  });

  test("unknown prefix falls back to default provider as raw", () => {
    // "claude/sonnet" 首段 "claude" 不是已知供应商 → 视为裸 id 整体
    assert.deepEqual(splitModelId("claude/sonnet-4-5", ["openrouter"]), {
      provider: "opencode",
      raw: "claude/sonnet-4-5",
      prefixed: false,
    });
  });

  test("empty/null input handled", () => {
    assert.deepEqual(splitModelId("", ["openrouter"]).raw, "");
    assert.deepEqual(splitModelId(null, ["openrouter"]).raw, "");
  });

  test("joinModelId keeps bare for default provider, prefixes others", () => {
    assert.equal(joinModelId("opencode", "deepseek-v4-flash-free"), "deepseek-v4-flash-free");
    assert.equal(joinModelId("openrouter", "google/gemma:free"), "openrouter/google/gemma:free");
    assert.equal(joinModelId("oc", "x-free"), "x-free", "alias oc normalized to opencode");
  });

  test("normalizeProviderId maps aliases", () => {
    assert.equal(normalizeProviderId("oc"), DEFAULT_PROVIDER);
    assert.equal(normalizeProviderId("opencode"), DEFAULT_PROVIDER);
    assert.equal(normalizeProviderId("openrouter"), "openrouter");
  });
});