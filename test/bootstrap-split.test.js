import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";

const FILES = [
  "src/runtime/bootstrap.js",
  "src/runtime/providers-setup.js",
  "src/runtime/server-lifecycle.js",
  "src/runtime/group-sync.js",
  "src/runtime/broadband.js",
  "src/runtime/broadband-stream.js",
];

describe("bootstrap 拆分体积门", () => {
  test("US1 六文件存在且各 ≤10KB", async () => {
    // 红阶段：新模块缺失即抛 MODULE_NOT_FOUND
    for (const f of FILES.slice(1)) await import(`../${f}`);
    for (const f of FILES) {
      const size = statSync(f).size;
      assert.ok(size <= 10240, `${f} ${size}B 超 10KB`);
    }
  });

  test("US2 门面仍导出 startDaemonMain", async () => {
    const m = await import("../src/runtime/bootstrap.js");
    assert.equal(typeof m.startDaemonMain, "function");
  });
});
