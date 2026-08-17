import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadToken, refreshToken, setPort, getPort } from "../src/state.js";

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