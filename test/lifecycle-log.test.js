import { test } from "node:test";
import assert from "node:assert/strict";
import { lifecycleStartLine, lifecycleHeartbeatLine } from "../src/runtime/lifecycle-log.js";

test("lifecycleStartLine：启动行含 pid/ppid/version/node/platform/cwd", () => {
  const line = lifecycleStartLine({ version: "0.1.126", pid: 111, ppid: 222, node: "v16.20.2", platform: "win32", cwd: "D:/x" });
  assert.match(line, /^\[lifecycle\] start /);
  assert.match(line, /pid=111/);
  assert.match(line, /ppid=222/);
  assert.match(line, /version=0\.1\.126/);
  assert.match(line, /node=v16\.20\.2/);
  assert.match(line, /platform=win32/);
  assert.match(line, /cwd=D:\/x/);
});

test("lifecycleHeartbeatLine：心跳行含 pid/uptime/rss", () => {
  const line = lifecycleHeartbeatLine({ pid: 7, uptimeMin: 30, rssMb: 88 });
  assert.equal(line, "[lifecycle] heartbeat pid=7 uptime=30m rss=88mb");
});
