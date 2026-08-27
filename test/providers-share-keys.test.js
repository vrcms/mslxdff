import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildShareKeysHeader, parseShareKeysHeader, shareableProviderIds } from "../src/providers/share-keys.js";
import { saveProviderKeys, saveProviderShareKeys } from "../src/state.js";

function stateFile() {
  return join(mkdtempSync(join(tmpdir(), "sk-")), "state.json");
}
function cleanup(file) {
  rmSync(join(file, ".."), { recursive: true, force: true });
}

test("share-keys: provider with keys + share on is shareable (via real state)", () => {
  const file = stateFile();
  try {
    saveProviderKeys("openrouter", ["sk-a", "sk-b"], { file });
    saveProviderShareKeys("openrouter", true, { file });
    assert.ok(shareableProviderIds({ file }).includes("openrouter"));
    assert.deepEqual(buildShareKeysHeader("openrouter/google/gemma:free", { file }), "openrouter=sk-a,sk-b");
  } finally { cleanup(file); }
});

test("share-keys: share off -> not shareable, no header", () => {
  const file = stateFile();
  try {
    saveProviderKeys("openrouter", ["sk-a"], { file });
    saveProviderShareKeys("openrouter", false, { file });
    const ids = shareableProviderIds({ file });
    assert.ok(!ids.includes("openrouter"));
    assert.equal(buildShareKeysHeader("openrouter/google/gemma:free", { file }), null);
  } finally { cleanup(file); }
});

test("share-keys: bare opencode model never gets a share header", () => {
  const file = stateFile();
  try {
    saveProviderKeys("openrouter", ["sk-a"], { file });
    saveProviderShareKeys("openrouter", true, { file });
    assert.equal(buildShareKeysHeader("big-pickle", { file }), null);
    assert.equal(buildShareKeysHeader("deepseek-v4-flash-free", { file }), null);
  } finally { cleanup(file); }
});

test("share-keys: env whitelist can never include opencode", () => {
  const file = stateFile();
  process.env.MSLXDFF_SHARE_PROVIDERS = "opencode,openrouter";
  try {
    assert.deepEqual(shareableProviderIds({ file }), ["openrouter"]);
  } finally {
    delete process.env.MSLXDFF_SHARE_PROVIDERS;
    cleanup(file);
  }
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