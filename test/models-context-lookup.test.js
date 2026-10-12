// 模型上下文窗口四级解析单测（ADR-0054）：L1 自报 > L2 内置表 > L3 models.dev caps > L4 兜底。
// 解析器是 /v1/models 富化的唯一窗口真相源，双层同源同值由此保证。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONTEXT_FALLBACK,
  contextFallback,
  firstPartyContextOf,
  knownContextOf,
  resolveContextLength,
} from "../src/model-capabilities/context-lookup.js";

const ENV = "MSLXDFF_MODEL_CONTEXT_FALLBACK";
function withEnv(v, fn) {
  const old = process.env[ENV];
  if (v === undefined) delete process.env[ENV];
  else process.env[ENV] = v;
  try { return fn(); } finally {
    if (old === undefined) delete process.env[ENV];
    else process.env[ENV] = old;
  }
}

test("contextFallback：默认 1M，env 覆盖，0/负=关，非法=默认", () => {
  withEnv(undefined, () => assert.equal(contextFallback(), DEFAULT_CONTEXT_FALLBACK));
  withEnv("500000", () => assert.equal(contextFallback(), 500000));
  withEnv("0", () => assert.equal(contextFallback(), 0));
  withEnv("-1", () => assert.equal(contextFallback(), 0));
  withEnv("abc", () => assert.equal(contextFallback(), DEFAULT_CONTEXT_FALLBACK));
  withEnv("100.9", () => assert.equal(contextFallback(), 100));
  // (0,1) floor 成 0 会静默变"关兜底"——按非法回默认（评审 r1-P2）
  withEnv("0.5", () => assert.equal(contextFallback(), DEFAULT_CONTEXT_FALLBACK));
});

test("firstPartyContextOf：四键读取链覆盖现网全部自报形状", () => {
  assert.equal(firstPartyContextOf({ context_length: 128000 }), 128000); // raccoon/qoder/traework 旧形状
  assert.equal(firstPartyContextOf({ maxInputTokens: 131072 }), 131072); // workbuddy/codearts 形状
  assert.equal(firstPartyContextOf({ max_input_tokens: "180000" }), 180000); // qwenwork 系 snake 形状
  assert.equal(firstPartyContextOf({ contextWindow: 256000 }), 256000);
  assert.equal(firstPartyContextOf({ contextWindow: { defaultLength: 200000, supportedLengths: [200000, 1000000] } }), 200000); // globalworkbuddy 对象形状
});

test("firstPartyContextOf：非法值丢弃而非钳制（0/负/非数字=未自报）", () => {
  assert.equal(firstPartyContextOf({ context_length: 0 }), null);
  assert.equal(firstPartyContextOf({ context_length: -5 }), null);
  assert.equal(firstPartyContextOf({ context_length: "abc" }), null);
  assert.equal(firstPartyContextOf({ context_length: true }), null); // boolean 不是自报（评审 r1-P2）
  assert.equal(firstPartyContextOf({ context_length: ["128000"] }), null); // 单元素数组不猜
  assert.equal(firstPartyContextOf({ context_length: { n: 1 } }), null); // 对象不猜
  assert.equal(firstPartyContextOf({}), null);
  assert.equal(firstPartyContextOf(null), null);
});

test("firstPartyContextOf：键序在前面的合法键赢，非法键跳过", () => {
  assert.equal(firstPartyContextOf({ context_length: 0, maxInputTokens: 64000 }), 64000);
  assert.equal(firstPartyContextOf({ context_length: 1000, maxInputTokens: 64000 }), 1000);
});

test("knownContextOf：内置表现为空；注入假表按条目 id 小写命中", () => {
  assert.equal(knownContextOf("whatever/model"), null);
  assert.equal(knownContextOf(""), null);
  assert.equal(knownContextOf(null), null);
  const fake = { "prov/x": { context: 64000, source: "test" } };
  assert.equal(knownContextOf("PROV/X ", fake), 64000);
  assert.equal(knownContextOf("prov/y", fake), null);
});

test("resolveContextLength：L1 自报优先于 L3 目录", () => {
  const caps = { context: 128000 };
  assert.equal(resolveContextLength({ entry: { context_length: 1000000 }, id: "raccoon/sn-kimi-k3", caps }), 1000000);
});

test("resolveContextLength：L2 假表压过 L3 目录（锁四级顺序，评审 r2-P1）", () => {
  const fake = { "prov/only-id": { context: 262144, source: "test" } };
  assert.equal(
    resolveContextLength({ entry: {}, id: "prov/only-id", caps: { context: 128000 }, knownTable: fake }),
    262144,
  );
  // L1 仍在 L2 之前
  assert.equal(
    resolveContextLength({ entry: { context_length: 9999 }, id: "prov/only-id", caps: null, knownTable: fake }),
    9999,
  );
});

test("resolveContextLength：L3 目录命中（无自报无内置）", () => {
  withEnv(undefined, () => {
    assert.equal(resolveContextLength({ entry: {}, id: "opencode/big-pickle", caps: { context: 128000 } }), 128000);
    // caps.context 非法（0/null）= L3 空
    assert.equal(resolveContextLength({ entry: {}, id: "x/y", caps: { context: 0 } }), DEFAULT_CONTEXT_FALLBACK);
    assert.equal(resolveContextLength({ entry: {}, id: "x/y", caps: null }), DEFAULT_CONTEXT_FALLBACK);
  });
});

test("resolveContextLength：L4 兜底 1M；env=0 关闭兜底返回 null", () => {
  withEnv(undefined, () => assert.equal(resolveContextLength({ entry: {}, id: "traework/kimi-k3", caps: null }), 1_000_000));
  withEnv("0", () => assert.equal(resolveContextLength({ entry: {}, id: "x/y", caps: null }), null));
  withEnv("0", () => assert.equal(resolveContextLength({ entry: { context_length: 64000 }, id: "x/y", caps: null }), 64000)); // 关兜底不影响 L1
});
