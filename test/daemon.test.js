import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pidFile, logFile, writePid, readPid, readPidVersion, isPidAlive, stopDaemon, startDaemon } from "../src/daemon.js";

const DIR = mkdtempSync(join(tmpdir(), "mslxdff-daemon-"));

process.env.MSLXDFF_DAEMON_DIR = DIR;
process.env.MSLXDFF_STATE_FILE = join(DIR, "state.json");

test("pidFile and logFile live under daemon dir", () => {
  assert.equal(pidFile(), join(DIR, "daemon.pid"));
  assert.equal(logFile(), join(DIR, "daemon.log"));
});

test("writePid/readPid round-trips", () => {
  writePid(12345);
  assert.equal(readPid(), 12345);
});

test("writePid with version and readPidVersion round-trips", () => {
  writePid(23456, "0.2.0");
  assert.equal(readPid(), 23456);
  assert.equal(readPidVersion(), "0.2.0");
});

test("legacy pid files (number only) still resolve with null version", () => {
  writePid(34567);
  assert.equal(readPid(), 34567);
  assert.equal(readPidVersion(), null);
});

test("isPidAlive detects a running process and a dead pid", () => {
  // this very test process is alive
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(2_147_483_647), false);
});

test("stopDaemon returns stopped:false when no pid", () => {
  const f = pidFile();
  try {
    unlinkSync(f);
  } catch {}
  const r = stopDaemon();
  assert.equal(r.stopped, false);
});

test("startDaemon spawns a detached child and stopDaemon kills it", async () => {
  process.env.PORT = "0";
  const pid = startDaemon([]);
  assert.ok(pid > 0);
  // poll for the pid file to appear (child writes it after server ready)
  for (let i = 0; i < 20; i++) {
    if (readPid()) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(readPid(), pid);
  const stopped = stopDaemon();
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.pid, pid);
});