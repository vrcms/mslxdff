import { test, describe } from "node:test";
import assert from "node:assert/strict";

describe("mslxdff provider + dash->slash alias inbound", () => {
  test("toInternalId strips mslxdff- once, original remains (legacy util)", async () => {
    const { toInternalId, toExternalAlias } = await import("../src/sync-opencode.js");
    assert.equal(toInternalId("mslxdff-deepseek"), "deepseek");
    assert.equal(toInternalId("deepseek"), "deepseek");
    assert.equal(toInternalId("mslxdff-mslxdff-deepseek"), "mslxdff-deepseek");
    assert.equal(toInternalId(""), "");
    assert.equal(toExternalAlias("deepseek"), "mslxdff-deepseek");
    assert.equal(toExternalAlias("mslxdff-deepseek"), "mslxdff-deepseek");
    assert.equal(toExternalAlias(""), "");
  });

  test("toStorageKey slash->dash", async () => {
    const { toStorageKey } = await import("../src/sync-opencode.js");
    assert.equal(toStorageKey("deepseek-v4-flash-free"), "deepseek-v4-flash-free");
    assert.equal(toStorageKey("bai/deepseek-v4-flash"), "bai-deepseek-v4-flash");
  });

  test("chat gateway: mslxdff/<model> stripping + dash->slash alias (simulated)", async () => {
    const { getModelAlias } = await import("../src/providers/model-id.js");
    // 确保 alias 表已包含测试所需
    const { loadModelAliases, registerModelAlias } = await import("../src/providers/model-id.js");
    loadModelAliases();
    registerModelAlias("bai-deepseek-v4-flash", "bai/deepseek-v4-flash");
    registerModelAlias("workbuddy-hy3", "workbuddy/hy3");
    function simulateGateway(rawModel) {
      let requested = rawModel;
      // 首轮 alias: dash->slash (如 bai-deepseek)
      const alias1 = getModelAlias(requested);
      if (alias1) requested = alias1;
      // mslxdff/ 前缀剥离
      if (requested.startsWith("mslxdff/")) {
        const rawPart = requested.slice("mslxdff/".length);
        requested = rawPart;
        const alias2 = getModelAlias(requested);
        if (alias2) requested = alias2;
      }
      return requested;
    }
    assert.equal(simulateGateway("deepseek-v4-flash-free"), "deepseek-v4-flash-free");
    assert.equal(simulateGateway("mslxdff/deepseek-v4-flash-free"), "deepseek-v4-flash-free");
    assert.equal(simulateGateway("bai-deepseek-v4-flash"), "bai/deepseek-v4-flash");
    assert.equal(simulateGateway("mslxdff/bai-deepseek-v4-flash"), "bai/deepseek-v4-flash");
    assert.equal(simulateGateway("bai/deepseek-v4-flash"), "bai/deepseek-v4-flash");
    assert.equal(simulateGateway("mslxdff/bai/deepseek-v4-flash"), "bai/deepseek-v4-flash");
    assert.equal(simulateGateway("workbuddy/hy3"), "workbuddy/hy3");
    assert.equal(simulateGateway("workbuddy-hy3"), "workbuddy/hy3");
  });
});
