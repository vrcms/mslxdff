import { test } from "node:test";
import assert from "node:assert/strict";
import { isResponsesModel, setResponsesNpmIndex, _resetResponsesNpmIndex } from "../src/upstream-responses.js";
import { normalizeModelCaps } from "../src/model-capabilities/parse.js";
import { createCapabilitiesService } from "../src/model-capabilities/index.js";

test("S1：normalizeModelCaps 保留模型级 provider.npm（无覆盖为 null）", () => {
  assert.equal(normalizeModelCaps("m", { provider: { npm: "@ai-sdk/openai" } }).npm, "@ai-sdk/openai");
  assert.equal(normalizeModelCaps("m", {}).npm, null);
  assert.equal(normalizeModelCaps("m", { provider: {} }).npm, null);
});

test("S2：元数据优先——npm=@ai-sdk/openai → responses；有覆盖但非 openai → chat", () => {
  setResponsesNpmIndex(new Map([
    ["muse-spark-2-future", "@ai-sdk/openai"],
    ["some-chat-model", "@ai-sdk/openai-compatible"],
    ["claude-x", "@ai-sdk/anthropic"],
  ]));
  assert.equal(isResponsesModel("muse-spark-2-future"), true, "元数据命中（新模型无需改码）");
  assert.equal(isResponsesModel("some-chat-model"), false);
  assert.equal(isResponsesModel("claude-x"), false, "非 openai 的 SDK 覆盖不误判 responses");
  assert.equal(isResponsesModel("opencode/muse-spark-2-future"), true, "带 provider 前缀也命中");
  _resetResponsesNpmIndex();
});

test("S2：未命中/未注入 → 前缀兜底（不回归）", () => {
  assert.equal(isResponsesModel("muse-spark-1.3-contributor-free"), true, "未注入时前缀兜底");
  assert.equal(isResponsesModel("big-pickle"), false);
  setResponsesNpmIndex(new Map([["other", "@ai-sdk/openai-compatible"]]));
  assert.equal(isResponsesModel("muse-spark-9"), true, "索引未收录 → 前缀兜底");
  assert.equal(isResponsesModel("big-pickle"), false);
  _resetResponsesNpmIndex();
});

test("S3：capabilities 服务 npmIndex 从数据构建（opencode 裸 id → npm）", async () => {
  const data = {
    opencode: {
      models: {
        "muse-spark-1.3-contributor-free": { id: "muse-spark-1.3-contributor-free", provider: { npm: "@ai-sdk/openai" } },
        "big-pickle": { id: "big-pickle" },
      },
    },
    other: { models: { x: { id: "x", provider: { npm: "@ai-sdk/openai" } } } },
  };
  const svc = createCapabilitiesService({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => data }),
    cacheFile: "",
    ttlMs: 100000,
  });
  await svc.ready();
  const idx = svc.npmIndex();
  assert.equal(idx.get("muse-spark-1.3-contributor-free"), "@ai-sdk/openai");
  assert.equal(idx.get("big-pickle"), null, "无 provider 覆盖 → null（继承 provider 默认 chat）");
  assert.equal(idx.has("x"), false, "非 opencode provider 不进此索引");
});
