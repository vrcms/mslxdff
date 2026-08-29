import { test, describe } from "node:test";
import assert from "node:assert/strict";

describe("mslxdff- alias inbound (原名仍兼容)", () => {
  test("toInternalId strips mslxdff- once, original remains", async () => {
    const { toInternalId, toExternalAlias } = await import("../src/sync-opencode.js");
    assert.equal(toInternalId("mslxdff-deepseek"), "deepseek");
    assert.equal(toInternalId("deepseek"), "deepseek");
    assert.equal(toInternalId("mslxdff-mslxdff-deepseek"), "mslxdff-deepseek");
    assert.equal(toInternalId(""), "");
    assert.equal(toExternalAlias("deepseek"), "mslxdff-deepseek");
    assert.equal(toExternalAlias("mslxdff-deepseek"), "mslxdff-deepseek");
    assert.equal(toExternalAlias(""), "");
  });

  test("alias dedup: deepseek and mslxdff-deepseek are same logical model", async () => {
    const { toInternalId } = await import("../src/sync-opencode.js");
    assert.equal(toInternalId("deepseek"), toInternalId("mslxdff-deepseek"));
  });

  test("chat alias handling: mslxdff-deepseek -> deepseek (simulated)", async () => {
    const { toInternalId } = await import("../src/sync-opencode.js");
    function simulateChatRequested(rawModel) {
      let requested = rawModel;
      if (requested.startsWith("mslxdff-")) {
        requested = toInternalId(requested);
      } else if (requested.includes("/")) {
        const idx = requested.indexOf("/");
        const rawPart = requested.slice(idx + 1);
        const providerPart = requested.slice(0, idx);
        if (rawPart.startsWith("mslxdff-")) {
          const internal = toInternalId(rawPart);
          requested = providerPart === "mslxdff" ? internal : `${providerPart}/${internal}`;
        } else if (providerPart === "mslxdff") {
          requested = rawPart;
        }
      }
      return requested;
    }
    assert.equal(simulateChatRequested("mslxdff-deepseek"), "deepseek");
    assert.equal(simulateChatRequested("deepseek"), "deepseek");
    assert.equal(simulateChatRequested("mslxdff/mslxdff-deepseek"), "deepseek");
    assert.equal(simulateChatRequested("mslxdff/deepseek"), "deepseek");
    assert.equal(simulateChatRequested("workbuddy/deepseek"), "workbuddy/deepseek");
  });
});
