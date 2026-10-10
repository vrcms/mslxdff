// Claude Desktop 角色槽纯函数层：槽位分配、截断、空勾选集报错、alias/inferenceModels 形状。
import { test } from "node:test";
import assert from "node:assert/strict";
import { ROLE_SLOTS, planSlots, aliasPairs, toInferenceModels, slotRole, isRoleSlot } from "../src/claude-desktop/slots.js";

test("前三档槽位固定为 sonnet/opus/haiku（App 默认模型、手挑高质量、子 agent 后台调用各占一档）", () => {
  assert.deepEqual(ROLE_SLOTS.slice(0, 3), ["claude-sonnet-5", "claude-opus-5", "claude-haiku-5-5"]);
  assert.equal(slotRole("claude-haiku-5-5"), "haiku");
  assert.equal(slotRole("claude-fable-5-1"), "fable");
  assert.equal(isRoleSlot("qwenwork/flash"), false);
});

test("planSlots：preferred 上首槽，其余按勾选顺序，去重", () => {
  const { rows } = planSlots({ picks: ["a-free", "b-free", "a-free", "c-free"], preferred: "c-free" });
  assert.deepEqual(rows.map((r) => r.model), ["c-free", "a-free", "b-free"]);
  assert.deepEqual(rows.map((r) => r.slot), ["claude-sonnet-5", "claude-opus-5", "claude-haiku-5-5"]);
});

test("planSlots：--max 截断并如实报 overflow/dropped（槽位上限 12 是 App 目录决定的，不是我们发明的）", () => {
  const picks = ["m1", "m2", "m3", "m4"];
  const { rows, overflow, dropped } = planSlots({ picks, max: 2 });
  assert.equal(rows.length, 2);
  assert.equal(overflow, 2);
  assert.deepEqual(dropped, ["m3", "m4"]);
  assert.ok(planSlots({ picks }).rows.length <= ROLE_SLOTS.length, "不给 max 也不得越过槽位上限");
});

test("planSlots：勾选集为空即抛错，绝不兜底 preferredModel（失效 id 写进客户端 = 每次请求 502）", () => {
  assert.throws(() => planSlots({ picks: [], preferred: "gone-model" }), /没有可写入的模型/);
  assert.throws(() => planSlots({}), /没有可写入的模型/);
});

test("toInferenceModels：name=槽位、labelOverride=真模型名（App 菜单里认得出来），maxEffort 可选", () => {
  const { rows } = planSlots({ picks: ["qwenwork/pro", "traework/kimi-k3"] });
  const list = toInferenceModels(rows);
  assert.deepEqual(list[0], { name: "claude-sonnet-5", labelOverride: "qwenwork/pro" });
  assert.equal(list[1].name, "claude-opus-5");
  assert.equal(list[1].maxEffort, undefined);
  const capped = toInferenceModels(rows, { maxEffort: "high" });
  assert.equal(capped[0].maxEffort, "high");
});

test("aliasPairs：只出「槽位 ≠ 真模型」的对（同名的没必要写进 alias 表）", () => {
  const pairs = aliasPairs([
    { slot: "claude-sonnet-5", model: "qwenwork/pro" },
    { slot: "claude-opus-5", model: "claude-opus-5" },
    null,
  ]);
  assert.deepEqual(pairs, [["claude-sonnet-5", "qwenwork/pro"]]);
});
