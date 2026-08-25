import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadToken, refreshToken, setPort, getPort, loadModelPicks, saveModelPicks } from "../src/state.js";

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