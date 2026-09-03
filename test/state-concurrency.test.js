import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryState } from "../src/state/memory.js";

describe("C4 并发解锁：内存态隔离", () => {
  test("US1 两内存实例互不污染", async () => {
    const a = createMemoryState("mem://conc-a");
    const b = createMemoryState("mem://conc-b");
    await Promise.all([
      (async () => { a.saveProviderKeys("prov", ["k-a"]); })(),
      (async () => { b.saveProviderKeys("prov", ["k-b"]); })(),
    ]);
    assert.deepEqual(a.loadProviderKeys("prov"), ["k-a"]);
    assert.deepEqual(b.loadProviderKeys("prov"), ["k-b"]);
  });

  test("US2 同实例并发 savePeers 后读一致", async () => {
    const m = createMemoryState("mem://conc-c");
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        (async () => { m.savePeers([{ name: `p${i}`, url: `http://127.0.0.1:${9000 + i}` }]); })()
      )
    );
    const peers = m.loadPeers();
    assert.ok(Array.isArray(peers) && peers.length === 1, "last write wins, single entry");
  });

  test("US3 文件态双 tmp 路径互不污染", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mslxdff-conc-"));
    const f1 = join(dir, "s1.json");
    const f2 = join(dir, "s2.json");
    const { saveModelPicks, loadModelPicks } = await import("../src/state/schemas/model.js");
    saveModelPicks(["pick-1"], { file: f1 });
    saveModelPicks(["pick-2"], { file: f2 });
    assert.deepEqual(loadModelPicks({ file: f1 }), ["pick-1"]);
    assert.deepEqual(loadModelPicks({ file: f2 }), ["pick-2"]);
  });
});
