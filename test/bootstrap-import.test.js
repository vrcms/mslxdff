import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("bootstrap import smoke", () => {
  it("src/runtime/bootstrap.js 可被 import 且无缺失模块", async () => {
    let err = null;
    try {
      await import("../src/runtime/bootstrap.js");
    } catch (e) {
      err = e;
    }
    // 允许因 env 未就绪抛其他错，但绝不能是 ERR_MODULE_NOT_FOUND
    if (err && err.code === "ERR_MODULE_NOT_FOUND") {
      assert.fail(`bootstrap 存在缺失 import: ${err.message}`);
    }
    assert.ok(true);
  });

  it("src/cli/bootstrap.js 透传正常", async () => {
    let err = null;
    try {
      await import("../src/cli/bootstrap.js");
    } catch (e) {
      err = e;
    }
    if (err && err.code === "ERR_MODULE_NOT_FOUND") {
      assert.fail(`cli/bootstrap 透传失败: ${err.message}`);
    }
    assert.ok(true);
  });
});
