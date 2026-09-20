import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { writeStateImmediate } from "../src/state/store.js";
import { buildProviderRows } from "../src/cli/provider-row.js";
import { filterStalePicks } from "../src/providers/model-id.js";

// 实测 state 快照：providerConfigs keys 无 amddev/laguna，picks 23 个含 4 孤儿
const KNOWN = ["workbuddy", "sensenova", "bai", "aihubmix", "cline", "deepseek"];
const LIVE = ["big-pickle", "deepseek-v4-flash-free", "mimo-v2.5-free"];
const ALLOWED = ["workbuddy/glm-5.3-flash", "cline/z-ai/glm-5.3-flash"];
const ALIAS = { "cline-z-ai-glm-5.3-flash": "cline/z-ai/glm-5.3-flash" };
const OPTS = { knownProviders: KNOWN, liveIds: LIVE, allowedIds: ALLOWED, resolveAlias: (x) => ALIAS[x] || null };

describe("filterStalePicks", () => {
  it("未知前缀 picks 滤除（amddev supplier 不存在）", () => {
    const out = filterStalePicks(["amddev/DeepSeek-V4-Flash", "amddev/Qwen3.8-Flash-Next"], OPTS);
    assert.deepEqual(out, []);
  });

  it("bare 孤儿滤除（laguna 不在上游也不在 allowlist）", () => {
    const out = filterStalePicks(["laguna-s-2.1-free"], OPTS);
    assert.deepEqual(out, []);
  });

  it("未启用/不存在的 provider 一律滤除（deepseek 缺 baseUrl 不在已知集合）", () => {
    const out = filterStalePicks(["deepseek/deepseek-chat-free"], {
      ...OPTS,
      knownProviders: KNOWN.filter((k) => k !== "deepseek"),
    });
    assert.deepEqual(out, []);
  });

  it("bare 上游模型保留（big-pickle）", () => {
    const out = filterStalePicks(["big-pickle"], OPTS);
    assert.deepEqual(out, ["big-pickle"]);
  });

  it("allowlist 成员保留（workbuddy/glm-5.3-flash）", () => {
    const out = filterStalePicks(["workbuddy/glm-5.3-flash"], OPTS);
    assert.deepEqual(out, ["workbuddy/glm-5.3-flash"]);
  });

  it("大小写不敏感 + dash 别名经 resolveAlias 还原后保留", () => {
    const out = filterStalePicks(
      ["AMDDEV/DeepSeek-V4-Flash", "cline-z-ai-glm-5.3-flash"],
      OPTS,
    );
    assert.deepEqual(out, ["cline-z-ai-glm-5.3-flash"]);
  });

  it("上游列表为空时 bare 一律保留（无法判定则放行）", () => {
    const out = filterStalePicks(["laguna-s-2.1-free", "big-pickle"], { knownProviders: KNOWN, liveIds: [], allowedIds: [] });
    assert.deepEqual(out, ["laguna-s-2.1-free", "big-pickle"]);
  });

  it("集成：enabled 口径与 -provider list 一致（deepseek 有key无baseUrl→滤，workbuddy→留）", async () => {
    const dir = mkdtempSync(join(os.tmpdir(), "mslxdff-stale-picks-"));
    const file = join(dir, "state.json");
    const prev = process.env.MSLXDFF_STATE_FILE;
    process.env.MSLXDFF_STATE_FILE = file;
    try {
      writeStateImmediate(file, {
        providerKeys: {
          deepseek: ["k-oretestkey"],
          workbuddy: ["eyJhbGciOiJIUzI1NiJ9averylongtestkey1234567890"],
        },
        providerConfigs: { deepseek: {}, workbuddy: {} },
      });
      const known = buildProviderRows({}).filter((r) => r.enabled).map((r) => r.id);
      assert.ok(!known.includes("deepseek"));
      assert.ok(known.includes("workbuddy"));
      assert.ok(known.includes("opencode"));
      const out = filterStalePicks(
        ["deepseek/deepseek-chat-free", "workbuddy/glm-5.3-flash"],
        { knownProviders: known, liveIds: [], allowedIds: [] },
      );
      assert.deepEqual(out, ["workbuddy/glm-5.3-flash"]);
    } finally {
      if (prev === undefined) delete process.env.MSLXDFF_STATE_FILE;
      else process.env.MSLXDFF_STATE_FILE = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
