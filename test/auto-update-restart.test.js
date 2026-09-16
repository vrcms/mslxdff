import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnRestartViaCli } from "../src/runtime/auto-update.js";

test("spawnRestartViaCli：-restart 委托参数正确，且剔除 MSLXDFF_DAEMON/DEBUG（否则子进程守卫 no-op）", () => {
  const calls = [];
  const child = { pid: 4242, unref() { calls.push("unref"); } };
  const spawnFn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return child; };
  const pid = spawnRestartViaCli({
    spawnFn,
    nodePath: "C:/node/node.exe",
    entry: "D:/app/bin/mslxdff.js",
    logFd: 7,
    env: { PATH: "x", MSLXDFF_DAEMON: "1", MSLXDFF_DEBUG: "1", KEEP: "y" },
  });
  assert.equal(pid, 4242);
  const c = calls.find((x) => typeof x === "object");
  assert.equal(c.cmd, "C:/node/node.exe");
  assert.deepEqual(c.args, ["D:/app/bin/mslxdff.js", "-restart"]);
  assert.equal(c.opts.detached, true);
  assert.deepEqual(c.opts.stdio, ["ignore", 7, 7]);
  assert.equal(c.opts.env.MSLXDFF_DAEMON, undefined, "必须剔除 MSLXDFF_DAEMON");
  assert.equal(c.opts.env.MSLXDFF_DEBUG, undefined);
  assert.equal(c.opts.env.KEEP, "y");
  assert.equal(c.opts.env.PATH, "x");
  assert.ok(calls.includes("unref"), "子进程必须 unref");
});
