import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sortModelIds, providerOf, providerRank } from "../src/cli/commands/model/list-sort.js";
import { groupByProvider } from "../src/cli/commands/model/list-render.js";

describe("-models 排序：opencode free 优先 + 供应商分组 + 组内有序", () => {
  test("US1 opencode free 模型排在最前，且按字母序", () => {
    const input = ["zeta", "mimo-v2.5-free", "big-pickle", "alpha-free", "gpt-5"];
    assert.deepEqual(sortModelIds(input), [
      "alpha-free",
      "big-pickle",
      "mimo-v2.5-free",
      "gpt-5",
      "zeta",
    ]);
  });

  test("US2 供应商段按已知顺序，未知供应商按字母序排在已知之后", () => {
    const input = [
      "zeta/x",
      "aai/x",
      "workbuddy/hy3",
      "cline/deepseek",
      "openrouter/foo",
      "big-pickle",
    ];
    const out = sortModelIds(input);
    assert.equal(out[0], "big-pickle", "opencode free 永远第一");
    const provs = out.map(providerOf);
    assert.deepEqual(provs, ["opencode", "workbuddy", "cline", "openrouter", "aai", "zeta"]);
  });

  test("US3 opencode 非 free 排在 opencode free 之后、其他供应商之前", () => {
    const out = sortModelIds(["cline/x", "gpt-5-paid", "big-pickle"]);
    assert.deepEqual(out, ["big-pickle", "gpt-5-paid", "cline/x"]);
  });

  test("US4 不改原数组（纯函数）", () => {
    const input = ["b", "a"];
    const out = sortModelIds(input);
    assert.deepEqual(input, ["b", "a"]);
    assert.notEqual(out, input);
  });

  test("US5 组内也排序：groupByProvider 输出按字母序", () => {
    const { groups, sortedProvs } = groupByProvider(["b-free", "a-free", "cline/z", "cline/a"]);
    assert.deepEqual(groups.opencode, ["a-free", "b-free"]);
    assert.deepEqual(groups.cline, ["cline/a", "cline/z"]);
    assert.deepEqual(sortedProvs, ["opencode", "cline"]);
  });

  test("US6 providerOf：无斜杠裸 id 归 opencode，斜杠取前缀且小写", () => {
    assert.equal(providerOf("big-pickle"), "opencode");
    assert.equal(providerOf("WorkBuddy/hy3"), "workbuddy");
  });

  test("US7 providerRank 单调：opencode < 已知供应商 < 未知供应商", () => {
    assert.ok(providerRank("opencode") < providerRank("workbuddy"));
    assert.ok(providerRank("openrouter") < providerRank("zzz-unknown"));
  });
});
