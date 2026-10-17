import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../src/server.js";
import { createRouter } from "../src/routes.js";

async function boot() {
  const srv = startServer({ router: createRouter({}, {}) }, 0);
  await srv.ready();
  const port = srv.server.address().port;
  return { srv, port };
}

async function shutdown(srv) {
  await srv.close();
  srv.server.closeAllConnections?.();
  srv.server.unref?.();
}

test("health is public and returns ok", async () => {
  const { srv, port } = await boot();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    // pid/version 是 BUG-29 的修复前提：重启后的健康检查要能判断「应答的是不是我刚起的那个」，
    // 否则旧 daemon 占着端口也会让 waitForHealth 通过，把 EADDRINUSE 秒退谎报成 restarted。
    assert.equal(body.pid, process.pid);
    assert.equal(typeof body.version, "string");
  } finally {
    await shutdown(srv);
  }
});

test("unknown route returns 404", async () => {
  const { srv, port } = await boot();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(res.status, 404);
  } finally {
    await shutdown(srv);
  }
});