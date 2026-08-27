import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadToken, refreshToken, setPort, getPort, loadModelPicks, saveModelPicks, loadProviderKeys, loadProviderKey, saveProviderKeys, addProviderKey, removeProviderKey, removeProviderKeys } from "../src/state.js";

function tmpStateFile() {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-"));
  return join(dir, "state.json");
}

test("generateToken returns a 64-char hex secret", async () => {
  const { generateToken } = await import("../src/state.js");
  const token = generateToken();
  assert.match(token, /^[0-9a-f]{64}$/);
});

test("first load persists a token to a 0600 state file and returns it", { skip: process.platform === "win32" && "POSIX permission bits are meaningless on Windows" }, async () => {
  const file = tmpStateFile();
  const { token, created } = await loadToken({ file });
  assert.equal(created, true);
  assert.match(token, /^[0-9a-f]{64}$/);
  const stat = statSync(file);
  assert.equal(stat.mode & 0o777, 0o600);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.token, token);
  assert.ok(saved.createdAt);
});

test("second load reuses the persisted token and reports not-created", async () => {
  const file = tmpStateFile();
  const first = await loadToken({ file });
  const { token: second, created } = await loadToken({ file });
  assert.equal(second, first.token);
  assert.equal(created, false);
});

test("refreshToken rotates the persisted token", async () => {
  const file = tmpStateFile();
  const old = await loadToken({ file });
  const fresh = await refreshToken({ file });
  assert.notEqual(fresh, old.token);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.token, fresh);
  const { token } = await loadToken({ file });
  assert.equal(token, fresh);
});

test("refreshToken writes mode 0600", { skip: process.platform === "win32" && "POSIX permission bits are meaningless on Windows" }, async () => {
  const file = tmpStateFile();
  await refreshToken({ file });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const entries = readdirSync(join(file, ".."));
  assert.equal(entries.length, 1);
});

test("setPort persists a port, getPort reads it back", async () => {
  const file = tmpStateFile();
  await loadToken({ file });
  setPort(8989, { file });
  assert.equal(getPort({ file }), 8989);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.port, 8989);
  assert.ok(saved.token, "token must be preserved");
});

test("setPort overrides a previous port", async () => {
  const file = tmpStateFile();
  await loadToken({ file });
  setPort(8989, { file });
  setPort(8000, { file });
  assert.equal(getPort({ file }), 8000);
});

test("getPort returns null when no port persisted", async () => {
  const file = tmpStateFile();
  await loadToken({ file });
  assert.equal(getPort({ file }), null);
});

test("saveModelPicks persists and loadModelPicks reads back", async () => {
  const file = tmpStateFile();
  const saved = saveModelPicks(["big-pickle", "hy3-free"], { file });
  assert.deepEqual(saved, ["big-pickle", "hy3-free"]);
  assert.deepEqual(loadModelPicks({ file }), ["big-pickle", "hy3-free"]);
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(onDisk.modelPicks, ["big-pickle", "hy3-free"]);
});

test("saveModelPicks dedupes and ignores empty strings", async () => {
  const file = tmpStateFile();
  saveModelPicks(["big-pickle", "big-pickle", "", " "], { file });
  assert.deepEqual(loadModelPicks({ file }), ["big-pickle"]);
});

test("loadModelPicks returns [] when never saved or not an array", async () => {
  const f1 = tmpStateFile();
  assert.deepEqual(loadModelPicks({ file: f1 }), []);
  // 直接用 JSON 注入非法形状（绕开状态内存缓存，避免同毫秒 mtime 命中旧缓存）
  const f2 = tmpStateFile();
  writeFileSync(f2, JSON.stringify({ modelPicks: { big: 1 } }));
  assert.deepEqual(loadModelPicks({ file: f2 }), []);
});

test("clearing picks (empty array) is stored and loads back empty", async () => {
  const file = tmpStateFile();
  saveModelPicks(["big-pickle"], { file });
  saveModelPicks([], { file });
  assert.deepEqual(loadModelPicks({ file }), []);
});
test("provider keys: save multiple, load back as array", async () => {
  const file = tmpStateFile();
  saveProviderKeys("openrouter", ["sk-1", "sk-2", "sk-3"], { file });
  assert.deepEqual(loadProviderKeys("openrouter", { file }), ["sk-1", "sk-2", "sk-3"]);
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(onDisk.providerKeys.openrouter, ["sk-1", "sk-2", "sk-3"]);
});

test("provider keys: legacy single string state reads back as array", async () => {
  const file = tmpStateFile();
  writeFileSync(file, JSON.stringify({ providerKeys: { openrouter: "sk-old" } }));
  assert.deepEqual(loadProviderKeys("openrouter", { file }), ["sk-old"]);
  assert.equal(loadProviderKey("openrouter", { file }), "sk-old");
});

test("provider keys: env MSLXDFF_<ID>_KEY takes priority over state", async () => {
  const file = tmpStateFile();
  saveProviderKeys("openrouter", ["sk-state"], { file });
  const key = process.env.MSLXDFF_OPENROUTER_KEY;
  process.env.MSLXDFF_OPENROUTER_KEY = "sk-env";
  try {
    assert.deepEqual(loadProviderKeys("openrouter", { file }), ["sk-env"]);
  } finally {
    if (key === undefined) delete process.env.MSLXDFF_OPENROUTER_KEY;
    else process.env.MSLXDFF_OPENROUTER_KEY = key;
  }
});

test("provider keys: add appends, remove deletes by value", async () => {
  const file = tmpStateFile();
  saveProviderKeys("openrouter", ["sk-1"], { file });
  assert.deepEqual(addProviderKey("openrouter", "sk-2", { file }), ["sk-1", "sk-2"]);
  assert.deepEqual(addProviderKey("openrouter", "sk-1", { file }), ["sk-1", "sk-2"], "dedupe on add");
  assert.deepEqual(removeProviderKey("openrouter", "sk-1", { file }), ["sk-2"]);
});

test("provider keys: clear via saveProviderKeys empty removes the entry", async () => {
  const file = tmpStateFile();
  saveProviderKeys("openrouter", ["sk-1", "sk-2"], { file });
  saveProviderKeys("openrouter", [], { file });
  assert.deepEqual(loadProviderKeys("openrouter", { file }), []);
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(onDisk.providerKeys.openrouter, undefined);
});

test("provider keys: removeProviderKeys removes several by value in one call", async () => {
  const file = tmpStateFile();
  saveProviderKeys("openrouter", ["sk-1", "sk-2", "sk-3", "sk-4"], { file });
  assert.deepEqual(removeProviderKeys("openrouter", ["sk-1", "sk-3"], { file }), ["sk-2", "sk-4"]);
  assert.deepEqual(loadProviderKeys("openrouter", { file }), ["sk-2", "sk-4"]);
});

test("provider keys: addProviderKey dedupes identical key (no duplicates stored)", async () => {
  const file = tmpStateFile();
  saveProviderKeys("openrouter", ["sk-1"], { file });
  assert.deepEqual(addProviderKey("openrouter", "sk-1", { file }), ["sk-1"], "duplicate add is a no-op");
  assert.deepEqual(loadProviderKeys("openrouter", { file }), ["sk-1"]);
});

test("provider keys: saveProviderKeys dedupes incoming duplicates", async () => {
  const file = tmpStateFile();
  assert.deepEqual(saveProviderKeys("openrouter", ["sk-1", "sk-2", "sk-1", "SK-1"], { file }), ["sk-1", "sk-2", "SK-1"]);
});
