import { test } from "node:test";
import assert from "node:assert/strict";
import { createSdkDispatch, sdkEnvName } from "../src/upstream-engine/sdk/dispatch.js";

test("sdkEnvName：id 非字母数字转 _ 并大写", () => {
  assert.equal(sdkEnvName("b.ai"), "MSLXDFF_B_AI_SDK");
  assert.equal(sdkEnvName("openrouter"), "MSLXDFF_OPENROUTER_SDK");
  assert.equal(sdkEnvName("ai-hub mix"), "MSLXDFF_AI_HUB_MIX_SDK");
});

test("createSdkDispatch：缺省 sdk，局部 legacy/关闭词回退，未设置继承全局总闸", () => {
  assert.equal(createSdkDispatch({ id: "my", env: {} }).enabled, true, "缺省 sdk");
  assert.equal(createSdkDispatch({ id: "my", env: { MSLXDFF_MY_SDK: "0" } }).enabled, false);
  assert.equal(createSdkDispatch({ id: "my", env: { MSLXDFF_MY_SDK: "legacy" } }).enabled, false);
  assert.equal(createSdkDispatch({ id: "my", env: { MSLXDFF_UPSTREAM_ENGINE: "legacy" } }).enabled, false, "继承全局熔断");
  assert.equal(createSdkDispatch({ id: "my", env: { MSLXDFF_UPSTREAM_ENGINE: "legacy", MSLXDFF_MY_SDK: "1" } }).enabled, true, "局部覆盖");
  assert.equal(createSdkDispatch({ id: "my", env: {} }).varName, "MSLXDFF_MY_SDK");
});

test("trySdk：成功返回 Response 且带统一标记头", async () => {
  const d = createSdkDispatch({
    id: "my",
    env: {},
    attemptImpl: async ({ marker }) => new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream", [marker.name]: marker.value } }),
  });
  const r = await d.trySdk({ url: "https://x/chat/completions" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-mslxdff-upstream-engine"), "sdk");
});

test("trySdk：_sdkLoadFailed → null（回退信号）且告警一次；非装载错误 rethrow", async () => {
  const errors = [];
  let calls = 0;
  const d = createSdkDispatch({
    id: "my",
    env: {},
    logger: { error: (m) => errors.push(m) },
    attemptImpl: async () => { calls++; const e = new Error("sdk missing"); e._sdkLoadFailed = true; throw e; },
  });
  assert.equal(await d.trySdk({ url: "https://x/chat/completions" }), null);
  assert.equal(await d.trySdk({ url: "https://x/chat/completions" }), null);
  assert.equal(calls, 2, "回退后由调用方决定是否再走 SDK");
  assert.equal(errors.length, 1, "回退告警只打一次");

  const d2 = createSdkDispatch({
    id: "my",
    env: {},
    attemptImpl: async () => { throw new Error("boom"); },
  });
  await assert.rejects(() => d2.trySdk({ url: "https://x/chat/completions" }), /boom/);
});

test("trySdk：markerName=null 时不加标记头", async () => {
  const d = createSdkDispatch({
    id: "my",
    env: {},
    markerName: null,
    attemptImpl: async ({ marker }) => new Response("ok", { status: 200, headers: marker ? { [marker.name]: marker.value } : {} }),
  });
  const r = await d.trySdk({ url: "https://x/chat/completions" });
  assert.equal(r.headers.get("x-mslxdff-upstream-engine"), null);
});

test("trySdk：_sdkUnsupported（异形 chatPath）静默回退且不告警", async () => {
  const errors = [];
  const d = createSdkDispatch({
    id: "my",
    env: {},
    logger: { error: (m) => errors.push(m) },
    attemptImpl: async () => { const e = new Error("chatPath 暂不支持"); e._sdkUnsupported = true; throw e; },
  });
  assert.equal(await d.trySdk({ url: "https://x/api/v2/chat" }), null);
  assert.equal(errors.length, 0, "异形 chatPath 属正常回退，不告警");
});
