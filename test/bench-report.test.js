import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatReport, sortResults } from "../src/bench/report.js";

describe("bench/report", () => {
  it("成功优先按 TTFB 排序并标 *", () => {
    const list = [
      { id: "b", ok: true, ttfbMs: 800, totalMs: 1200, tps: 10, label: "成功" },
      { id: "a", ok: true, ttfbMs: 100, totalMs: 300, tps: 30, label: "成功" },
      { id: "c", ok: false, ttfbMs: 50, totalMs: 100, label: "限流", error: "429" },
    ];
    const sorted = sortResults(list);
    assert.equal(sorted[0].id, "a");
    assert.equal(sorted[1].id, "b");
    assert.equal(sorted[2].id, "c");
    const rep = formatReport(list);
    assert.ok(rep.text.includes("* a") || rep.text.includes("*a"));
    assert.equal(rep.winner.id, "a");
  });

  it("--json 输出结构", () => {
    const list = [{ id: "x", ok: true, ttfbMs: 10, totalMs: 20, tps: 50, label: "成功", tokens: { completion: 5 } }];
    const rep = formatReport(list, { json: true });
    const parsed = JSON.parse(rep.text);
    assert.equal(parsed[0].id, "x");
    assert.equal(rep.winner.id, "x");
  });

  it("全部失败时提示", () => {
    const list = [{ id: "m", ok: false, label: "余额不足", error: "insufficient" }];
    const rep = formatReport(list);
    assert.ok(rep.text.includes("无可用模型"));
  });
});
