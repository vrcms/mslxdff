import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";

// 对齐 scripts/check-file-size.js 的分级：>20KB 红（必须拆）、>10KB 黄（警告不阻塞）。
const WARN = 10 * 1024;
const FAIL = 20 * 1024;

const FILES = [
  "src/runtime/bootstrap.js",
  "src/runtime/providers-setup.js",
  "src/runtime/server-lifecycle.js",
  "src/runtime/group-sync.js",
  "src/runtime/broadband.js",
  "src/runtime/broadband-stream.js",
];

describe("bootstrap 拆分体积门", () => {
  test("US1 六文件存在；>20KB 报错必须拆，>10KB 仅警告", async () => {
    // 新模块缺失即抛 MODULE_NOT_FOUND（存在性是硬门，与体积分级无关）
    for (const f of FILES.slice(1)) await import(`../${f}`);
    for (const f of FILES) {
      const size = statSync(f).size;
      assert.ok(size <= FAIL, `${f} ${size}B 超 20KB 必须拆分`);
      if (size > WARN) console.warn(`⚠ ${f} ${(size / 1024).toFixed(1)}KB >10KB 建议按职责再拆（不阻塞）`);
    }
  });

  test("US2 门面仍导出 startDaemonMain", async () => {
    const m = await import("../src/runtime/bootstrap.js");
    assert.equal(typeof m.startDaemonMain, "function");
  });
});
