// /v1/models 能力富化（ADR-0022）：merge 层 + handler 挂接
// 测试接缝：capsSvc（目录）+ wbSource（workbuddy 动态源），与 merge.js 约定一致
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  splitModelId,
  upstreamApiFor,
  capsPayloadFor,
  mergeModelsList,
} from "../src/model-capabilities/merge.js";

function fakeSvc(entries) {
  const map = new Map(); // provider -> Map(raw -> caps)
  for (const [provider, raw, caps] of entries) {
    if (!map.has(provider)) map.set(provider, new Map());
    map.get(provider).set(raw, caps);
  }
  return {
    readyWarm: async () => true,
    get: (p, m) => map.get(String(p).toLowerCase())?.get(m) || null,
  };
}

// L4 兜底默认值会读 env；兜底断言的测试用 withFallback 钉死行为（undefined=恢复未设）
async function withFallback(v, fn) {
  const ENV = "MSLXDFF_MODEL_CONTEXT_FALLBACK";
  const old = process.env[ENV];
  if (v === undefined) delete process.env[ENV];
  else process.env[ENV] = v;
  try { return await fn(); } finally {
    if (old === undefined) delete process.env[ENV];
    else process.env[ENV] = old;
  }
}

const CAPS = {
  reasoning: true,
  effortType: "effort",
  effortValues: ["low", "medium", "high"],
  imageInput: true,
  toolCall: true,
  context: 128000,
  maxOutput: 8192,
  costIn: 0.5,
  costOut: 2,
  npm: null,
  inputModalities: ["text", "image"],
  outputModalities: ["text"],
};

test("splitModelId: 裸 id 归 opencode，前缀小写", () => {
  assert.deepEqual(splitModelId("big-pickle"), { provider: "opencode", raw: "big-pickle" });
  assert.deepEqual(splitModelId("WorkBuddy/hy3"), { provider: "workbuddy", raw: "hy3" });
  assert.deepEqual(splitModelId("cline/deepseek/deepseek-v4-flash"), {
    provider: "cline",
    raw: "deepseek/deepseek-v4-flash",
  });
});

test("upstreamApiFor: muse-spark 与 npm @ai-sdk/openai 走 responses", () => {
  assert.equal(upstreamApiFor(null, "muse-spark-1.2-contributor"), "responses");
  assert.equal(upstreamApiFor(null, "muse-spark-1.2-contributor-free"), "responses");
  assert.equal(upstreamApiFor({ npm: "@ai-sdk/openai" }, "gpt-x"), "responses");
  assert.equal(upstreamApiFor({ npm: "@ai-sdk/anthropic" }, "glm-5.3"), "chat");
  assert.equal(upstreamApiFor(null, "glm-5.3"), "chat");
});

test("capsPayloadFor: 只填有值字段 + endpoints/upstreamApi", () => {
  const p = capsPayloadFor(CAPS, "deepseek-v4-flash-free");
  assert.equal(p.reasoning, true);
  assert.deepEqual(p.effortValues, ["low", "medium", "high"]);
  assert.equal(p.context, 128000);
  assert.equal(p.maxOutput, 8192);
  assert.deepEqual(p.endpoints, ["chat", "responses"]);
  assert.equal(p.upstreamApi, "chat");
  // 未收录字段不硬造
  const slim = capsPayloadFor({ reasoning: false, toolCall: false, imageInput: false }, "x");
  assert.ok(!("context" in slim));
  assert.ok(!("costIn" in slim));
  assert.ok(!("effortType" in slim));
  assert.deepEqual(slim.inputModalities, ["text"]);
  assert.equal(capsPayloadFor(null, "x"), null);
});

test("mergeModelsList: 裸 id 精确命中（context 双层同源）", async () => {
  const data = { object: "list", data: [{ id: "big-pickle", object: "model" }] };
  const svc = fakeSvc([["opencode", "big-pickle", CAPS]]);
  const out = await mergeModelsList(data, { capsSvc: svc, wbSource: null });
  assert.equal(out.data[0].capabilities.reasoning, true);
  assert.equal(out.data[0].capabilities.context, 128000);
  assert.equal(out.data[0].context_length, 128000, "顶层与 capabilities 同值（ADR-0054）");
});

test("mergeModelsList: -free 后缀剥离回退", async () => {
  const data = { object: "list", data: [{ id: "glm-5.3-free", object: "model" }] };
  const svc = fakeSvc([["opencode", "glm-5.3", CAPS]]);
  const out = await mergeModelsList(data, { capsSvc: svc, wbSource: null });
  assert.equal(out.data[0].capabilities.context, 128000);
});

test("mergeModelsList: 二级厂商前缀回退（cline/deepseek/x）", async () => {
  const data = { object: "list", data: [{ id: "cline/deepseek/deepseek-v4-flash", object: "model" }] };
  const svc = fakeSvc([["deepseek", "deepseek-v4-flash", CAPS]]);
  const out = await mergeModelsList(data, { capsSvc: svc, wbSource: null });
  assert.equal(out.data[0].capabilities.toolCall, true);
});

test("mergeModelsList: 未收录模型补兜底 context（双层同源），不硬造能力声明", async () => {
  const data = { object: "list", data: [{ id: "totally-unknown-model", object: "model" }] };
  const svc = fakeSvc([]);
  const out = await withFallback(undefined, () => mergeModelsList(data, { capsSvc: svc, wbSource: null }));
  assert.deepEqual(out.data[0].capabilities, { context: 1_000_000 });
  assert.equal(out.data[0].context_length, 1_000_000);
  assert.ok(!("reasoning" in out.data[0].capabilities)); // 能力不知道就沉默
});

test("mergeModelsList: workbuddy 兜底走上游原生字段源（L3=wb caps），顶层同步一致", async () => {
  const data = { object: "list", data: [{ id: "workbuddy/hy3", object: "model" }] };
  const svc = fakeSvc([]); // models.dev 无 workbuddy
  const wbSource = async () => ({
    object: "list",
    data: [{ id: "workbuddy/hy3", supportsImages: true, supportsReasoning: true, supportsToolCall: true, maxInputTokens: 131072, maxOutputTokens: 16384 }],
  });
  const out = await mergeModelsList(data, { capsSvc: svc, wbSource });
  assert.equal(out.data[0].capabilities.imageInput, true);
  assert.equal(out.data[0].capabilities.context, 131072);
  assert.equal(out.data[0].context_length, 131072, "双层同源（ADR-0054）");
});

test("mergeModelsList: 冷目录不阻塞（readyWarm false → L3 跳过，L1+L4 照常生效）", async () => {
  const data = { object: "list", data: [
    { id: "big-pickle", object: "model" },
    { id: "raccoon/sn-kimi-k3", object: "model", context_length: 256000 },
  ] };
  const svc = { readyWarm: async () => false, get: () => null };
  const out = await withFallback(undefined, () => mergeModelsList(data, { capsSvc: svc, wbSource: null }));
  assert.deepEqual(out.data[0].capabilities, { context: 1_000_000 });
  assert.equal(out.data[1].capabilities.context, 256000, "冷缓存下 L1 自报照常生效");
});

test("mergeModelsList: 目录抛错 → 不挂，仍补 L1+L4", async () => {
  const data = { object: "list", data: [{ id: "big-pickle", object: "model" }] };
  const svc = { readyWarm: async () => { throw new Error("boom"); }, get: () => null };
  const out = await withFallback(undefined, () => mergeModelsList(data, { capsSvc: svc, wbSource: null }));
  assert.deepEqual(out.data[0].capabilities, { context: 1_000_000 });
});

test("mergeModelsList: 条目自报（L1）优先于目录（L3），caps 其余字段保留", async () => {
  const data = { object: "list", data: [{ id: "raccoon/sn-kimi-k3", object: "model", context_length: 1_000_000 }] };
  const svc = fakeSvc([["raccoon", "sn-kimi-k3", CAPS]]); // CAPS.context=128000
  const out = await mergeModelsList(data, { capsSvc: svc, wbSource: null });
  assert.equal(out.data[0].capabilities.context, 1_000_000);
  assert.equal(out.data[0].context_length, 1_000_000);
  assert.equal(out.data[0].capabilities.reasoning, true, "caps 命中时其余能力字段照常富化");
});

test("mergeModelsList: env=0 关兜底且全未命中 → 原样（旧口径），两层都不写", async () => {
  const data = { object: "list", data: [{ id: "totally-unknown-model", object: "model" }] };
  const svc = fakeSvc([]);
  const out = await withFallback("0", () => mergeModelsList(data, { capsSvc: svc, wbSource: null }));
  assert.ok(!("capabilities" in out.data[0]));
  assert.ok(!("context_length" in out.data[0]));
});

test("mergeModelsList: 空 data/畸形输入原样返回", async () => {
  const svc = fakeSvc([]);
  assert.deepEqual(await mergeModelsList(null, { capsSvc: svc, wbSource: null }), null);
  assert.deepEqual(await mergeModelsList({ object: "list" }, { capsSvc: svc, wbSource: null }), { object: "list" });
});
