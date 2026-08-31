import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  normalizeBaseUrl,
  normalizeAuths,
  normalizeAllowedModel,
  normalizeEndpointPath,
  validateProviderConfig,
  mergeProviderConfig,
} from "../src/state/provider-config.js";
import { COLD_WINS, mergeState } from "../src/state/merge.js";

function tmpFile() {
  const d = mkdtempSync(join(tmpdir(), "mslxdff-pconf-"));
  return join(d, "state.json");
}

describe("provider-config normalize", () => {
  test("US1 BaseUrl 去斜杠", () => {
    assert.equal(normalizeBaseUrl("https://x///"), "https://x");
    assert.equal(normalizeBaseUrl(""), "");
    assert.equal(normalizeBaseUrl("  https://y//  "), "https://y");
  });
  test("US2 Auths 缺 uid 丢弃", () => {
    const out = normalizeAuths([{ uid: "", domain: "a" }, { uid: "u1" }, { userId: "u2", enterprise_id: "e1" }]);
    assert.equal(out.length, 2);
    assert.equal(out[0].uid, "u1");
    assert.equal(out[0].domain, "www.codebuddy.cn");
    assert.equal(out[1].uid, "u2");
    assert.equal(out[1].enterpriseId, "e1");
  });
  test("US3 Allowed 剥前缀", () => {
    assert.equal(normalizeAllowedModel("openrouter/a", "openrouter"), "a");
    assert.equal(normalizeAllowedModel("a", "openrouter"), "a");
    assert.equal(normalizeAllowedModel("OpenRouter/A", "openrouter"), "A");
    assert.equal(normalizeAllowedModel("", "x"), "");
    assert.equal(normalizeEndpointPath("models"), "/models");
    assert.equal(normalizeEndpointPath("/chat"), "/chat");
  });
});

describe("provider-config validate", () => {
  test("US4 validate 7 字段归一", () => {
    const raw = { baseUrl: "https://x///", keys: ["k1", "", " k1 "], allowedModels: ["my/a", "b"], modelsPath: "models", chatPath: "chat/completions", auths: [{ uid: "u1" }] };
    const { ok, clean } = validateProviderConfig(raw, "my");
    assert.equal(ok, true);
    assert.equal(clean.baseUrl, "https://x");
    assert.deepEqual(clean.keys, ["k1"]);
    assert.deepEqual(clean.allowedModels, ["a", "b"]);
    assert.equal(clean.modelsPath, "/models");
    assert.equal(clean.chatPath, "/chat/completions");
    assert.equal(clean.auths[0].uid, "u1");
  });
  test("US4 validate 空 baseUrl 仍 ok（workbuddy 除外）", () => {
    const { ok, clean } = validateProviderConfig({ baseUrl: "", keys: [] }, "generic");
    assert.equal(ok, true);
    assert.equal(clean.baseUrl, "");
  });
});

describe("provider-config merge 三级", () => {
  test("US5 env 优先于 file 与 legacy", () => {
    const env = { baseUrl: "https://env", keys: ["envK"] };
    const file = { baseUrl: "https://file", keys: ["fileK"], allowedModels: ["fileM"] };
    const legacy = ["legacyK"];
    const out = mergeProviderConfig({ env, file, legacy }, "my");
    assert.equal(out.baseUrl, "https://env");
    assert.deepEqual(out.keys, ["envK"]);
  });
  test("US5 file 优先于 legacy", () => {
    const out = mergeProviderConfig({ env: {}, file: { baseUrl: "https://file", keys: ["fileK"] }, legacy: ["legacyK"] }, "my");
    assert.equal(out.baseUrl, "https://file");
  });
  test("US6 undefined 保留旧值语义（通过 save 透传）", async () => {
    const file = tmpFile();
    const { saveProviderConfig, loadProviderConfigs } = await import("../src/state/schemas/provider.js");
    // 先写旧值
    saveProviderConfig("my", { baseUrl: "https://old", keys: ["k1"], allowedModels: ["a"], modelsPath: "/models", chatPath: "/chat" }, { file });
    // 仅更新 baseUrl，不传 allowedModels
    saveProviderConfig("my", { baseUrl: "https://new" }, { file });
    const cfg = loadProviderConfigs({ file })["my"];
    assert.equal(cfg.baseUrl, "https://new");
    assert.deepEqual(cfg.allowedModels, ["a"], "undefined 应保留旧值");
    assert.equal(cfg.modelsPath, "/models");
    // 显式传 [] 应清空
    saveProviderConfig("my", { allowedModels: [] }, { file });
    const cfg2 = loadProviderConfigs({ file })["my"];
    assert.deepEqual(cfg2.allowedModels || [], []);
  });
});

describe("provider-config shareEnv", () => {
  test("US7 ON 大小写不敏感", async () => {
    const prev = process.env.MSLXDFF_MY_SHARE_KEYS;
    process.env.MSLXDFF_MY_SHARE_KEYS = "ON";
    const { loadProviderShareKeys } = await import("../src/state/schemas/provider.js");
    const file = tmpFile();
    assert.equal(loadProviderShareKeys("my", { file }), true);
    process.env.MSLXDFF_MY_SHARE_KEYS = "true";
    assert.equal(loadProviderShareKeys("my", { file }), true);
    process.env.MSLXDFF_MY_SHARE_KEYS = "off";
    assert.equal(loadProviderShareKeys("my", { file }), false);
    if (prev === undefined) delete process.env.MSLXDFF_MY_SHARE_KEYS;
    else process.env.MSLXDFF_MY_SHARE_KEYS = prev;
  });
});

describe("merge 同源", () => {
  test("US8 COLD_WINS 仅 merge.js 定义", async () => {
    const fs = await import("node:fs");
    const mergeTxt = fs.readFileSync("src/state/merge.js", "utf8");
    assert.ok(mergeTxt.includes("COLD_WINS"), "merge.js 应定义 COLD_WINS");
    const storeTxt = fs.readFileSync("src/state/store.js", "utf8");
    const memTxt = fs.readFileSync("src/state/memory.js", "utf8");
    // store/memory 不应再定义 new Set([...COLD_WINS])
    const storeDef = (storeTxt.match(/new Set\(\[/g) || []).length;
    const memDef = (memTxt.match(/new Set\(\[/g) || []).length;
    // 允许 store/memory 保留 0 定义，仅 import
    assert.equal(storeDef, 0, `store.js 不应再定义 COLD_WINS，实 ${storeDef}`);
    assert.equal(memDef, 0, `memory.js 不应再定义 COLD_WINS，实 ${memDef}`);
    // mergeState 纯函数存在
    assert.equal(typeof mergeState, "function");
    const disk = { providerConfigs: { a: 1 }, modelErrors: { x: 1 } };
    const mem = { providerConfigs: { b: 2 }, modelErrors: { y: 2 } };
    const merged = mergeState(disk, mem);
    assert.equal(merged.providerConfigs.a, 1);
    assert.equal(merged.modelErrors.y, 2);
    assert.ok(COLD_WINS.has("providerConfigs"));
  });
});
