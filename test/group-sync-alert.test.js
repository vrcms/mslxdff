// BUG-23（唯一成立且未修的那半）：group sync 失败静默——单次失败仅 console.log，
// 不重试、不进 errors.log。现网 349 次失败（288 aborted + 61 fetch failed）零记录。
// 但单次失败是常态，每次都喊会把 errors.log 也刷成噪声（BUG-5 的教训），故只对
// **连续失败**去抖升级：连续 ≥N 次写一条 errors.log，恢复时补一条收尾。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGroupSyncReporter } from "../src/runtime/group-sync.js";

function harness({ alertAt = 3 } = {}) {
  const lines = [];
  const errors = [];
  const report = createGroupSyncReporter({
    alertAt,
    log: (s) => lines.push(s),
    logs: { appendError: (e) => errors.push(e) },
  });
  return { report, lines, errors };
}

describe("BUG-23 group sync 连续失败去抖告警", () => {
  test("单次失败不喊：只 console.log，不进 errors.log", () => {
    const { report, lines, errors } = harness();
    report([{ name: "my@mslxd", error: "This operation was aborted" }]);
    assert.equal(errors.length, 0, "单次失败是常态，不该进 errors.log");
    assert.ok(lines.join("\n").includes("failed — This operation was aborted"));
  });

  test("连续 3 次失败才升级：errors.log 只写一条，含「已停在上一次成功」", () => {
    const { report, errors } = harness();
    for (let i = 0; i < 3; i++) report([{ name: "my@mslxd", error: "fetch failed" }]);
    assert.equal(errors.length, 1, "同一段连续失败只该喊一次");
    assert.equal(errors[0].status, 0);
    assert.equal(errors[0].group, "my@mslxd");
    assert.equal(errors[0].fails, 3);
    assert.match(errors[0].message, /连续 3 次失败/);
    assert.match(errors[0].message, /停留在上一次成功/, "要说清后果，而不只是失败次数");
  });

  test("继续失败不再重复写 errors.log（轨迹只走 console.log）", () => {
    const { report, lines, errors } = harness();
    for (let i = 0; i < 7; i++) report([{ name: "my@mslxd", error: "aborted" }]);
    assert.equal(errors.length, 1, "去抖后不该灌重复行");
    assert.equal(lines.length, 7, "每分钟的轨迹仍要留着");
  });

  test("恢复补一条收尾，且后续再失败能重新计数并再次告警", () => {
    const { report, lines, errors } = harness();
    for (let i = 0; i < 3; i++) report([{ name: "g", error: "boom" }]);
    report([{ name: "g", total: 7, added: 0 }]);
    assert.equal(errors.length, 2, "恢复要闭合事件");
    assert.match(errors[1].message, /已恢复：此前连续失败 3 次/);
    assert.equal(errors[1].status, 200);
    assert.ok(lines.join("\n").includes("已恢复"), "恢复也要给人话");
    // 再失败：计数从零重来，够阈值仍要再喊
    for (let i = 0; i < 3; i++) report([{ name: "g", error: "boom again" }]);
    assert.equal(errors.length, 3);
  });

  test("多个组各算各的连续计数，互不串味", () => {
    const { report, errors } = harness();
    report([{ name: "a", error: "x" }, { name: "b", total: 3, added: 1 }]);
    report([{ name: "a", error: "x" }, { name: "b", error: "y" }]);
    report([{ name: "a", error: "x" }, { name: "b", error: "y" }]);
    assert.equal(errors.length, 1, "只有 a 够 3 次");
    assert.equal(errors[0].group, "a");
  });

  test("alertAt=0（关闭升级）时只留 console.log", () => {
    const { report, errors } = harness({ alertAt: 0 });
    for (let i = 0; i < 10; i++) report([{ name: "g", error: "boom" }]);
    assert.equal(errors.length, 0);
  });

  test("成功轮次不刷屏：定时器路径只在 added>0 时打印（首拉 verbose 例外）", () => {
    const { report, lines } = harness();
    report([{ name: "g", total: 7, added: 0 }]); // 定时器路径：无变化不打印
    assert.equal(lines.length, 0);
    report([{ name: "g", total: 7, added: 2 }]); // 有变化要打印
    assert.equal(lines.length, 1);
    report([{ name: "g", total: 7, added: 0 }], { verbose: true }); // 首拉：必打
    assert.equal(lines.length, 2);
  });

  test("logs 缺失或 appendError 抛错不拖垮同步", () => {
    const lines = [];
    const report = createGroupSyncReporter({
      alertAt: 1,
      log: (s) => lines.push(s),
      logs: { appendError: () => { throw new Error("disk full"); } },
    });
    assert.doesNotThrow(() => report([{ name: "g", error: "boom" }]));
    assert.equal(lines.length, 1, "日志写失败也要把行打出来");
    const bare = createGroupSyncReporter({ alertAt: 1, log: () => {} });
    assert.doesNotThrow(() => bare([{ name: "g", error: "boom" }]));
  });
});
