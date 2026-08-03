import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(import.meta.dirname, "..", "bin", "mslxdff.js");

function runCli(args, env) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, MSLXDFF_DAEMON_DIR: tmpState(), ...env },
  });
  return { stdout: res.stdout, stderr: res.stderr, status: res.status };
}

let tmpCounter = 0;
function tmpState() {
  const dir = mkdtempSync(join(tmpdir(), `mslxdff-cli-${tmpCounter++}-`));
  return dir;
}

test("-help prints usage and exits 0", () => {
  const { stdout, status } = runCli(["-help"]);
  assert.equal(status, 0);
  assert.ok(stdout.includes("Usage:"));
  assert.ok(stdout.includes("-update"));
  assert.ok(stdout.includes("-status"));
  assert.ok(stdout.includes("mslxdff v"));
});

test("-status shows daemon/model/log sections even with no data", () => {
  const { stdout, status } = runCli(["-status"]);
  assert.equal(status, 0);
  assert.ok(stdout.includes("daemon:"));
  assert.ok(stdout.includes("models:"));
  assert.ok(stdout.includes("recent calls:"));
  assert.ok(stdout.includes("last error:"));
  assert.ok(stdout.includes("not running"));
});

test("-status shows cached models and recent calls when present", () => {
  const dir = tmpState();
  const modelsFile = join(dir, "models.json");
  writeFileSync(
    modelsFile,
    JSON.stringify({
      object: "list",
      cachedAt: Date.now(),
      data: [
        { id: "deepseek-v4-flash-free", object: "model" },
        { id: "big-pickle", object: "model" },
      ],
    })
  );
  const res = spawnSync(process.execPath, [BIN, "-status"], {
    encoding: "utf8",
    env: { ...process.env, MSLXDFF_DAEMON_DIR: dir },
  });
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes("deepseek-v4-flash-free"));
  assert.ok(res.stdout.includes("big-pickle"));
  assert.ok(res.stdout.includes("2 free"));
});

test("-showtoken works", () => {
  const { stdout, status } = runCli(["-showtoken"]);
  assert.equal(status, 0);
  assert.match(stdout.trim(), /^[0-9a-f]{64}$/);
});

test("-refresh-token rotates the token", () => {
  const dir = tmpState();
  const a = spawnSync(process.execPath, [BIN, "-showtoken"], { encoding: "utf8", env: { ...process.env, MSLXDFF_DAEMON_DIR: dir } });
  const b = spawnSync(process.execPath, [BIN, "-refresh-token"], { encoding: "utf8", env: { ...process.env, MSLXDFF_DAEMON_DIR: dir } });
  const c = spawnSync(process.execPath, [BIN, "-showtoken"], { encoding: "utf8", env: { ...process.env, MSLXDFF_DAEMON_DIR: dir } });
  assert.match(a.stdout.trim(), /^[0-9a-f]{64}$/);
  assert.match(b.stdout.trim(), /^[0-9a-f]{64}$/);
  assert.equal(c.stdout.trim(), b.stdout.trim());
  assert.notEqual(a.stdout.trim(), b.stdout.trim());
});
