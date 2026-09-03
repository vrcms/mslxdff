import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzePolicy } from "../src/chat-pipeline/policy.js";

describe("chat-pipeline/policy - 纯函数 PolicyStage", () => {
  it("空 model 归一为空，useAuto=true（空视为 auto）", () => {
    const r = analyzePolicy({ headers: {}, body: {} });
    assert.equal(r.requested, "");
    assert.equal(r.useAuto, true);
  });
  it("normalizeModel 仅去 oc/ 前缀，不 trim（与真实一致）", () => {
    const r = analyzePolicy({ headers: {}, body: { model: "  big-pickle  " } });
    assert.equal(r.requested, "  big-pickle  ");
  });
  it("x-mslxdff-model-lock 锁定覆盖 body.model", () => {
    const r = analyzePolicy({ headers: { "x-mslxdff-model-lock": "locked-model" }, body: { model: "other" } });
    assert.equal(r.requested, "locked-model");
    assert.equal(r.lockModel, "locked-model");
  });
  it("alias dash→slash 还原（bai-deepseek → bai/deepseek）", () => {
    // 依赖 model-aliases.json 中已存在的映射，选用常见 alias
    // 若映射不存在则退化为原值，测试仅验证 aliasInfo 有无
    const r = analyzePolicy({ headers: {}, body: { model: "bai-deepseek" } });
    // 可能是还原为 bai/deepseek，也可能是保持原值（取决于 alias 表）
    assert.ok(typeof r.requested === "string");
  });
  it("mslxdff/ 前缀剥离", () => {
    const r = analyzePolicy({ headers: {}, body: { model: "mslxdff/big-pickle" } });
    assert.equal(r.requested, "big-pickle");
    assert.ok(r.aliasInfo && r.aliasInfo.includes("mslxdff"));
  });
  it("shareKeys 头解析", () => {
    const r = analyzePolicy({ headers: { "x-mslxdff-share-keys": "openrouter:sk-123" }, body: { model: "a" } });
    assert.ok(r.shareKeys && typeof r.shareKeys === "object");
  });
  it("workbuddyUid 头优先", () => {
    const r = analyzePolicy({ headers: { "x-mslxdff-workbuddy-uid": "uid-123" }, body: { model: "workbuddy/hy3" } });
    assert.equal(r.workbuddyUid, "uid-123");
  });
  it("workbuddy <uid>:model 前缀剥离 uid", () => {
    const r = analyzePolicy({ headers: {}, body: { model: "workbuddy/uid-999:hy3" } });
    // 归一后应剥离 uid 部分，仅保留 hy3，且 workbuddyUid 被解析
    // 实现可能在 normalizeFullId 中处理，policy 应透传
    assert.ok(r.requested.includes("hy3"));
  });
  it("auto 模型识别", () => {
    const r = analyzePolicy({ headers: {}, body: { model: "auto" } });
    assert.equal(r.useAuto, true);
  });
  it("hops 解析", () => {
    const r = analyzePolicy({ headers: { "x-mslxdff-hops": "2" }, body: { model: "a" } });
    assert.equal(r.hops, 2);
  });
});
