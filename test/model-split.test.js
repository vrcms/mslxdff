import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";

const FILES = [
  "src/cli/commands/model.js",
  "src/cli/commands/model/status.js",
  "src/cli/commands/model/stats.js",
  "src/cli/commands/model/picks.js",
  "src/cli/commands/model/list.js",
  "src/cli/commands/model/list-render.js",
  "src/cli/commands/model/list-providers.js",
];

describe("model 命令拆分体积门", () => {
  test("US1 七文件存在且各 ≤10KB", async () => {
    // 红阶段：新模块缺失即抛 MODULE_NOT_FOUND
    for (const f of FILES.slice(1)) await import(`../${f}`);
    for (const f of FILES) {
      const size = statSync(f).size;
      assert.ok(size <= 10240, `${f} ${size}B 超 10KB`);
    }
  });

  test("US2 门面仍导出 handleModel", async () => {
    const m = await import("../src/cli/commands/model.js");
    assert.equal(typeof m.handleModel, "function");
  });
});
