// 回归：定制 provider 启用门禁。
// 背景：门禁曾要求 `baseUrl && keys` 两者皆有，导致 qoder（keys 有、baseUrl 空）被静默跳过 ——
// 表现为 /v1/models 无 qoder 模型、`-models` 挑不到、网关报 `Model qoder/qfmodel is not supported`。
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AUTH_DOC_PROVIDER_IDS, shouldEnableCustomProvider } from "../src/runtime/provider-gate.js";

describe("providers-setup 定制 provider 门禁", () => {
  it("qoder：有 keys 且 baseUrl 空 → 仍启用", () => {
    assert.equal(shouldEnableCustomProvider("qoder", { keys: ["{\"device_token\":\"dt-x\"}"] }), true);
  });
  it("auth 号型：无 keys 但 auths 行 / auth 目录有号 → 启用", () => {
    assert.equal(shouldEnableCustomProvider("qoder", { hasAuthDocs: true }), true);
    assert.equal(shouldEnableCustomProvider("traework", { auths: [{ uid: "u1" }] }), true);
    assert.equal(shouldEnableCustomProvider("workbuddy", { keys: ["jwt"] }), true);
  });
  it("auth 号型：三样都没有 → 不启用", () => {
    for (const id of ["qoder", "traework", "workbuddy"]) {
      assert.equal(shouldEnableCustomProvider(id, {}), false, `${id} 无凭证不应启用`);
    }
  });
  it("其他定制：有 keys 即启用（不再要求 baseUrl）；无 keys 跳过", () => {
    assert.equal(shouldEnableCustomProvider("cline", { keys: ["sk_1"] }), true);
    assert.equal(shouldEnableCustomProvider("codearts", { keys: ["{\"refreshToken\":\"x\"}"] }), true);
    assert.equal(shouldEnableCustomProvider("codearts", { hasAuthDocs: true }), false);
  });
  it("门禁名单含三家属（漏登记会让整家供应商消失）", () => {
    for (const id of ["workbuddy", "traework", "qoder"]) {
      assert.ok(AUTH_DOC_PROVIDER_IDS.includes(id), `名单缺 ${id}`);
    }
  });
});
