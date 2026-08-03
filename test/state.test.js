import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadToken, refreshToken } from "../src/state.js";

function tmpStateFile() {
  const dir = mkdtempSync(join(tmpdir(), "mslxdfree-"));
  return join(dir, "state.json");
}

test("generateToken returns a 64-char hex secret", async () => {
  const { generateToken } = await import("../src/state.js");
  const token = generateToken();
  assert.match(token, /^[0-9a-f]{64}$/);
});

test("first load persists a token to a 0600 state file and returns it", async () => {
  const file = tmpStateFile();
  const token = await loadToken({ file });
  assert.match(token, /^[0-9a-f]{64}$/);
  const stat = statSync(file);
  assert.equal(stat.mode & 0o777, 0o600);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.token, token);
  assert.ok(saved.createdAt);
});

test("second load reuses the persisted token", async () => {
  const file = tmpStateFile();
  const first = await loadToken({ file });
  const second = await loadToken({ file });
  assert.equal(second, first);
});

test("refreshToken rotates the persisted token", async () => {
  const file = tmpStateFile();
  const old = await loadToken({ file });
  const fresh = await refreshToken({ file });
  assert.notEqual(fresh, old);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.token, fresh);
  assert.equal(await loadToken({ file }), fresh);
});

test("refreshToken writes mode 0600", async () => {
  const file = tmpStateFile();
  await refreshToken({ file });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const entries = readdirSync(join(file, ".."));
  assert.equal(entries.length, 1);
});