import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planRoute } from "../src/chat-pipeline/planner.js";

describe("chat-pipeline/planner", () => {
  it("锁模型直接单点", () => {
    const r = planRoute({ requested: "a", lockModel: "a", useAuto: false }, {});
    assert.equal(r.strategy, "direct");
    assert.deepEqual(r.order, ["a"]);
  });
  it("ViaRoute 单路径", () => {
    const r = planRoute({ requested: "workbuddy/hy3", useAuto: false, lockModel: "" }, { viaRoute: { best: "peer:1" }, candidates: [] });
    assert.equal(r.strategy, "via");
  });
  it("auto 多候选产 autoRace 且 concLimit 5", () => {
    const r = planRoute({ requested: "auto", useAuto: true, lockModel: "" }, { candidates: ["a","b","c","d","e","f"] });
    assert.equal(r.strategy, "autoRace");
    assert.equal(r.concLimit, 5);
  });
  it("显式模型回退链首位为 requested", () => {
    const r = planRoute({ requested: "m1", useAuto: false, lockModel: "" }, { candidates: ["m2","m3"] });
    assert.equal(r.order[0], "m1");
    assert.ok(r.order.includes("m2"));
  });
  it("空 requested 回退候选", () => {
    const r = planRoute({ requested: "", useAuto: true, lockModel: "" }, { candidates: ["a","b"] });
    assert.equal(r.strategy, "autoRace");
  });
});
