// traework 条目不再自报上下文窗口（ADR-0054 决定 5）：无据的 131072 已删，窗口交由 /v1/models
// 富化的四级解析裁决（本 provider 无自报 → 落 L4 兜底）。此测试锁死"任何人加回来必红"。
import { test } from "node:test";
import assert from "node:assert/strict";
import { staticModels, STATIC_MODEL_IDS } from "../src/providers/traework/models.js";

test("staticModels：条目不携带 context_length（无据自报已删，落 L4 兜底）", () => {
  const list = staticModels();
  assert.equal(list.length, STATIC_MODEL_IDS.length);
  for (const m of list) {
    assert.equal("context_length" in m, false, `${m.id} 不得自报窗口`);
    assert.equal("maxInputTokens" in m, false, `${m.id} 不得自报窗口（snake/camel 任一形态）`);
    assert.equal("max_input_tokens" in m, false, `${m.id} 不得自报窗口（snake/camel 任一形态）`);
    assert.ok(String(m.id).startsWith("traework/"), `id 带本家前缀：${m.id}`);
    assert.equal(m.object, "model");
    assert.equal(m.owned_by, "trae-solo");
  }
});
