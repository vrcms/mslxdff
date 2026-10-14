// Claude Desktop 角色槽纯函数层：槽位分配、截断、空勾选集报错、alias/inferenceModels 形状。
import { test } from "node:test";
import assert from "node:assert/strict";
import { ROLE_SLOTS, planSlots, aliasPairs, toInferenceModels, slotRole, isRoleSlot, parseOneMMode, decideRows1m } from "../src/claude-desktop/slots.js";

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

test("toInferenceModels: supports1m 打标行出 supports1m+prefer1m 成对键且键序恒定；未标/显式 false 与历史逐字一致", () => {
  const rows = [
    { slot: "claude-sonnet-5", model: "big-1m", label: "big-1m", supports1m: true },
    { slot: "claude-opus-5", model: "muse-spark-1.2", label: "muse-spark-1.2" },
    { slot: "claude-haiku-5-5", model: "x-free", label: "x-free", supports1m: false },
  ];
  const list = toInferenceModels(rows, { maxEffort: "high" });
  assert.deepEqual(Object.keys(list[0]), ["name", "labelOverride", "supports1m", "prefer1m", "maxEffort"]);
  assert.equal(list[0].supports1m, true);
  assert.equal(list[0].prefer1m, true);
  assert.deepEqual(Object.keys(list[1]), ["name", "labelOverride", "maxEffort"]);
  assert.deepEqual(Object.keys(list[2]), ["name", "labelOverride", "maxEffort"]);
});

test("parseOneMMode: 保留字大小写不敏感、空值缺省 auto；非保留值一律列表（单条即长度 1）；空/纯分隔符 invalid", () => {
  assert.deepEqual(parseOneMMode(""), { mode: "auto", list: [] });
  assert.deepEqual(parseOneMMode("auto"), { mode: "auto", list: [] });
  assert.deepEqual(parseOneMMode("OFF"), { mode: "off", list: [] });
  assert.deepEqual(parseOneMMode(" All "), { mode: "all", list: [] });
  assert.deepEqual(parseOneMMode("claude-opus-5,WorkBuddy/GLM-5.3-Flash"), { mode: "list", list: ["claude-opus-5", "workbuddy/glm-5.3-flash"] });
  assert.deepEqual(parseOneMMode("yes"), { mode: "list", list: ["yes"] });
  assert.deepEqual(parseOneMMode(" , , "), { mode: "invalid" });
});

test("decideRows1m: auto 查 contexts（≥1M 打标、262144 与缺失不打）、all 全打、列表按 slot/model 小写精确匹配、off 全不打；不改入参", () => {
  const base = [
    { slot: "claude-sonnet-5", model: "big-1m", label: "big-1m" },
    { slot: "claude-opus-5", model: "Small-Free", label: "Small-Free" },
    { slot: "claude-haiku-5-5", model: "unknown-model", label: "unknown-model" },
  ];
  const contexts = new Map([["big-1m", 1_000_000], ["small-free", 262_144]]);
  const auto = decideRows1m({ rows: base, oneM: { mode: "auto", list: [] }, contexts });
  assert.equal(auto.rows[0].supports1m, true);
  assert.equal(auto.rows[1].supports1m, undefined, "262144 不足 1M");
  assert.equal(auto.rows[2].supports1m, undefined, "无证据不打");
  assert.ok(!("supports1m" in base[0]), "不改入参 rows");
  assert.deepEqual(decideRows1m({ rows: base, oneM: { mode: "all", list: [] } }).rows.map((r) => !!r.supports1m), [true, true, true]);
  assert.ok(decideRows1m({ rows: base, oneM: { mode: "off", list: [] } }).rows.every((r) => !r.supports1m));
  const bySlot = decideRows1m({ rows: base, oneM: { mode: "list", list: ["CLAUDE-OPUS-5", "no-such"] } });
  assert.equal(bySlot.rows[1].supports1m, true);
  assert.ok(!bySlot.rows[0].supports1m && !bySlot.rows[2].supports1m);
  assert.deepEqual(bySlot.unmatched, ["no-such"]);
  const byModel = decideRows1m({ rows: base, oneM: { mode: "list", list: ["unknown-model"] } });
  assert.equal(byModel.rows[2].supports1m, true, "真模型 id 也算命中");
  assert.deepEqual(byModel.unmatched, []);
});

test("decideRows1m preserve 语义（评审 1 P1-2）：auto 证据整体失败=全保留；负面证据才清；行级缺失=保留并入 preserved", () => {
  const rows = [
    { slot: "claude-sonnet-5", model: "big-1m", label: "big-1m" },
    { slot: "claude-opus-5", model: "small-free", label: "small-free" },
    { slot: "claude-haiku-5-5", model: "not-in-catalog", label: "not-in-catalog" },
  ];
  const preserve = new Map([["claude-sonnet-5", true], ["claude-opus-5", true], ["claude-haiku-5-5", true]]);
  const dead = decideRows1m({ rows, oneM: { mode: "auto", list: [] }, contexts: null, preserve });
  assert.deepEqual(dead.rows.map((r) => !!r.supports1m), [true, true, true], "证据层整体失败 = 保留全部既有标，不是静默抹标");
  assert.deepEqual(dead.preserved, ["claude-sonnet-5", "claude-opus-5", "claude-haiku-5-5"]);
  const contexts = new Map([["big-1m", 1_000_000], ["small-free", 262_144]]);
  const live = decideRows1m({ rows, oneM: { mode: "auto", list: [] }, contexts, preserve });
  assert.equal(live.rows[0].supports1m, true, "正面证据 ≥1M");
  assert.equal(live.rows[1].supports1m, undefined, "负面证据 262144 → 清标（有证据的修正）");
  assert.equal(live.rows[2].supports1m, true, "行级缺失 = 无证据 → 保留");
  assert.deepEqual(live.preserved, ["claude-haiku-5-5"]);
});
