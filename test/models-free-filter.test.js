import { test } from "node:test";
import assert from "node:assert/strict";
import { filterFreeModels, isFreeModel } from "../src/models.js";

// 与 9router/src/app/api/providers/suggested-models/filters.js:16-19 等价
// FILTERS["opencode-free"]: m.id?.endsWith("-free") || KNOWN_FREE_OPENCODE_MODELS.includes(id)
// KNOWN_FREE_OPENCODE_MODELS = ["big-pickle"]

test("isFreeModel matches 9Router opencode-free filter", () => {
  assert.equal(isFreeModel("deepseek-v4-flash-free"), true);
  assert.equal(isFreeModel("mimo-v2.5-free"), true);
  assert.equal(isFreeModel("big-pickle"), true);
  assert.equal(isFreeModel("gpt-4"), false);
  assert.equal(isFreeModel("claude-sonnet-4-5"), false);
  assert.equal(isFreeModel("gemini-2.5-pro"), false);
  assert.equal(isFreeModel(""), false);
  assert.equal(isFreeModel(null), false);
});

test("filterFreeModels keeps only -free and big-pickle, deduped", () => {
  const raw = [
    { id: "deepseek-v4-flash-free" },
    { id: "big-pickle" },
    { id: "gpt-4" },
    { id: "mimo-v2.5-free" },
    { id: "deepseek-v4-flash-free" }, // dup
    { id: null },
    {},
  ];
  const out = filterFreeModels(raw).map((m) => m.id);
  assert.deepEqual(out, ["deepseek-v4-flash-free", "big-pickle", "mimo-v2.5-free"]);
});

test("filterFreeModels handles empty/invalid input", () => {
  assert.deepEqual(filterFreeModels(null), []);
  assert.deepEqual(filterFreeModels([]), []);
  assert.deepEqual(filterFreeModels([{ id: "claude-sonnet-4-5" }]), []);
});
