import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createModelsService } from "../src/models.js";

async function stubModelsServer(dataFn, calls = () => {}) {
  const srv = createServer((req, res) => {
    calls();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(dataFn()));
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv)));
  return srv;
}

test("startAutoRefresh periodically refetches the upstream list", async () => {
  let count = 0;
  const srv = await stubModelsServer(
    () => ({ object: "list", data: [{ id: `model-${count}-free`, object: "model" }] }),
    () => count++
  );
  const service = createModelsService({
    baseUrl: `http://127.0.0.1:${srv.address().port}`,
    headers: { "x-opencode-client": "desktop" },
  });
  try {
    const first = await service.get();
    const firstId = first.data[0].id;
    assert.ok(firstId.endsWith("-free"));
    service.startAutoRefresh(30);
    // wait for at least 2 background refetches to be confident the timer fires
    await new Promise((r) => setTimeout(r, 200));
    service.stopAutoRefresh();
    assert.ok(count >= 3, `expected background refetch, got ${count}`);
    const second = await service.get();
    assert.notEqual(second.data[0].id, firstId, "background refresh must pick up newer data");
  } finally {
    service.stopAutoRefresh();
    await new Promise((r) => srv.close(r));
    srv.closeAllConnections?.();
  }
});

test("background refresh failure keeps serving stale cache", async () => {
  let fail = true;
  const srv = await stubModelsServer(
    () => ({ object: "list", data: [{ id: "deepseek-v4-flash-free", object: "model" }] }),
    () => {
      if (fail) {
        srv.close();
      }
    }
  );
  const service = createModelsService({
    baseUrl: `http://127.0.0.1:${srv.address().port}`,
    headers: { "x-opencode-client": "desktop" },
  });
  try {
    const first = await service.get();
    assert.deepEqual(first.data.map((m) => m.id), ["deepseek-v4-flash-free"]);
    // now break the upstream, background refresh should swallow the error
    fail = false;
    service.startAutoRefresh(30);
    await new Promise((r) => setTimeout(r, 120));
    service.stopAutoRefresh();
    const after = await service.get();
    assert.deepEqual(after.data.map((m) => m.id), ["deepseek-v4-flash-free"]);
  } finally {
    service.stopAutoRefresh();
  }
});
