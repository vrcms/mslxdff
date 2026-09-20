import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildShareKeysHeader, parseShareKeysHeader, shareableProviderIds } from "../src/providers/share-keys.js";
import { saveProviderKeys } from "../src/state.js";

function stateFile() {
  return join(mkdtempSync(join(tmpdir(), "sk-")), "state.json");
}
function cleanup(file) {
  rmSync(join(file, ".."), { recursive: true, force: true });
}

test("share-keys: 默认借出 —— 有 key 即可共享，无开关（ADR-0019）", () => {
  const file = stateFile();
  try {
    saveProviderKeys("openrouter", ["sk-a", "sk-b"], { file });
    assert.ok(shareableProviderIds({ file }).includes("openrouter"));
    assert.deepEqual(buildShareKeysHeader("openrouter/google/gemma:free", { file }), "openrouter=sk-a,sk-b");
  } finally { cleanup(file); }
});

test("share-keys: 刷新型凭据（cline/cline）硬排除", () => {
  const file = stateFile();
  try {
    saveProviderKeys("cline", ["rt-1"], { file });
    saveProviderKeys("cline", ["rt-2"], { file });
    saveProviderKeys("openrouter", ["sk-a"], { file });
    const ids = shareableProviderIds({ file });
    assert.ok(!ids.includes("cline"));
    assert.ok(!ids.includes("cline"));
    assert.ok(ids.includes("openrouter"));
  } finally { cleanup(file); }
});

test("share-keys: bare opencode model never gets a share header", () => {
  const file = stateFile();
  try {
    saveProviderKeys("openrouter", ["sk-a"], { file });
    assert.equal(buildShareKeysHeader("big-pickle", { file }), null);
    assert.equal(buildShareKeysHeader("deepseek-v4-flash-free", { file }), null);
  } finally { cleanup(file); }
});

test("share-keys: parseShareKeysHeader ignores opencode and malformed segments", () => {
  // opencode 忽略；bad=nospace 是合法单 key；空 key 段（openrouter2=）被跳过
  const out = parseShareKeysHeader("openrouter=sk-x,sk-y;opencode=sk-evil;bad=nospace;openrouter2=");
  assert.deepEqual(out, { openrouter: ["sk-x", "sk-y"], bad: ["nospace"] });
});

test("share-keys: parseShareKeysHeader empty input returns {}", () => {
  assert.deepEqual(parseShareKeysHeader(""), {});
  assert.deepEqual(parseShareKeysHeader(null), {});
});