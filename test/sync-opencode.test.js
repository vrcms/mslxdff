import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), "op-sync-"));
  return join(dir, "opencode.json");
}

describe("sync-opencode raw/dash + slash->dash alias", () => {
  test("toExternalAlias / toInternalId pure (legacy keeps mslxdff-)", async () => {
    const { toExternalAlias, toInternalId } = await import("../src/sync-opencode.js");
    assert.equal(toExternalAlias("deepseek"), "mslxdff-deepseek");
    assert.equal(toExternalAlias("mslxdff-deepseek"), "mslxdff-deepseek");
    assert.equal(toExternalAlias(""), "");
    assert.equal(toInternalId("mslxdff-deepseek"), "deepseek");
    assert.equal(toInternalId("deepseek"), "deepseek");
    assert.equal(toInternalId("mslxdff-mslxdff-deepseek"), "mslxdff-deepseek", "only strip one layer");
  });

  test("toStorageKey: slash -> dash, raw stays raw", async () => {
    const { toStorageKey } = await import("../src/sync-opencode.js");
    assert.equal(toStorageKey("deepseek-v4-flash-free"), "deepseek-v4-flash-free");
    assert.equal(toStorageKey("bai/deepseek-v4-flash"), "bai-deepseek-v4-flash");
    assert.equal(toStorageKey("clinebot/z-ai/glm-5.3-flash"), "clinebot-z-ai-glm-5.3-flash");
    assert.equal(toStorageKey("mslxdff-deepseek"), "deepseek", "legacy prefix stripped then raw");
  });

  test("buildOpencodeProvider creates raw key and local url", async () => {
    const { buildOpencodeProvider } = await import("../src/sync-opencode.js");
    const p = buildOpencodeProvider({ id: "deepseek-v4-flash-free", token: "tok", port: 8989 });
    assert.equal(p.npm, "@ai-sdk/openai-compatible");
    assert.equal(p.name, "mslxdff");
    assert.equal(p.options.baseURL, "http://127.0.0.1:8989/v1");
    assert.equal(p.options.apiKey, "tok");
    assert.ok(p.models["deepseek-v4-flash-free"], "should use raw key");
    assert.equal(p.models["deepseek-v4-flash-free"].name, "deepseek-v4-flash-free");
  });

  test("buildOpencodeProvider slash -> dash", async () => {
    const { buildOpencodeProvider } = await import("../src/sync-opencode.js");
    const p = buildOpencodeProvider({ id: "bai/deepseek-v4-flash", token: "tok", port: 8989 });
    assert.ok(p.models["bai-deepseek-v4-flash"], "slash should become dash");
  });

  test("empty file -> inserted raw", async () => {
    const file = tmpFile();
    const { syncToOpencode } = await import("../src/sync-opencode.js");
    const r = await syncToOpencode({ id: "deepseek-v4-flash-free", token: "tok1", port: 8989, file });
    assert.equal(r.action, "inserted");
    assert.equal(r.id, "deepseek-v4-flash-free");
    assert.equal(r.internal, "deepseek-v4-flash-free");
    const data = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(data.provider.mslxdff);
    assert.equal(data.provider.mslxdff.models["deepseek-v4-flash-free"].name, "deepseek-v4-flash-free");
    assert.equal(data.provider.mslxdff.options.baseURL, "http://127.0.0.1:8989/v1");
  });

  test("slash id -> dash stored and alias registered", async () => {
    const file = tmpFile();
    const { syncToOpencode } = await import("../src/sync-opencode.js");
    const r = await syncToOpencode({ id: "bai/deepseek-v4-flash", token: "tok1", port: 8989, file });
    assert.equal(r.action, "inserted");
    assert.equal(r.id, "bai-deepseek-v4-flash");
    assert.equal(r.internal, "bai/deepseek-v4-flash");
    const data = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(data.provider.mslxdff.models["bai-deepseek-v4-flash"]);
    // alias file should contain dash->slash
    const { getModelAlias } = await import("../src/providers/model-id.js");
    assert.equal(getModelAlias("bai-deepseek-v4-flash"), "bai/deepseek-v4-flash");
  });

  test("existing raw second sync is idempotent updated (no duplicate)", async () => {
    const file = tmpFile();
    const { syncToOpencode } = await import("../src/sync-opencode.js");
    await syncToOpencode({ id: "deepseek-v4-flash-free", token: "tok1", port: 8989, file });
    const r2 = await syncToOpencode({ id: "deepseek-v4-flash-free", token: "tok1", port: 8989, file });
    assert.equal(r2.action, "updated");
    const data = JSON.parse(readFileSync(file, "utf8"));
    const keys = Object.keys(data.provider.mslxdff.models);
    assert.equal(keys.length, 1);
    assert.ok(keys.includes("deepseek-v4-flash-free"));
  });

  test("slash second sync via dash is idempotent", async () => {
    const file = tmpFile();
    const { syncToOpencode } = await import("../src/sync-opencode.js");
    await syncToOpencode({ id: "bai/deepseek-v4-flash", token: "tok1", port: 8989, file });
    const r = await syncToOpencode({ id: "bai-deepseek-v4-flash", token: "tok1", port: 8989, file });
    assert.equal(r.action, "updated");
    const data = JSON.parse(readFileSync(file, "utf8"));
    const keys = Object.keys(data.provider.mslxdff.models);
    assert.equal(keys.length, 1);
    assert.ok(keys.includes("bai-deepseek-v4-flash"));
  });

  test("two different models accumulate as two raw/dash keys", async () => {
    const file = tmpFile();
    const { syncToOpencode } = await import("../src/sync-opencode.js");
    await syncToOpencode({ id: "deepseek-v4-flash-free", token: "tok", port: 8989, file });
    await syncToOpencode({ id: "big-pickle", token: "tok", port: 8989, file });
    const data = JSON.parse(readFileSync(file, "utf8"));
    const keys = Object.keys(data.provider.mslxdff.models).sort();
    assert.deepEqual(keys, ["big-pickle", "deepseek-v4-flash-free"]);
  });

  test("port change updates baseURL", async () => {
    const file = tmpFile();
    const { syncToOpencode } = await import("../src/sync-opencode.js");
    await syncToOpencode({ id: "deepseek-v4-flash-free", token: "tok1", port: 8989, file });
    await syncToOpencode({ id: "deepseek-v4-flash-free", token: "tok2", port: 8089, file });
    const data = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(data.provider.mslxdff.options.baseURL, "http://127.0.0.1:8089/v1");
    assert.equal(data.provider.mslxdff.options.apiKey, "tok2");
  });

  test("other providers preserved", async () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({
      provider: {
        groq: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://api.groq.com/openai/v1", apiKey: "gsk" }, models: { "a": { name: "a" } } },
        mslxdff: { npm: "@ai-sdk/openai-compatible", name: "mslxdff", options: { baseURL: "http://127.0.0.1:8989/v1", apiKey: "old" }, models: { "deepseek-v4-flash-free": { name: "deepseek-v4-flash-free" } } }
      },
      agent: { "test": { model: "x" } }
    }, null, 2));
    const { syncToOpencode } = await import("../src/sync-opencode.js");
    await syncToOpencode({ id: "big-pickle", token: "tok", port: 8989, file });
    const data = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(data.provider.groq, "other provider preserved");
    assert.ok(data.agent.test, "top-level preserved");
    assert.ok(data.provider.mslxdff.models["deepseek-v4-flash-free"]);
    assert.ok(data.provider.mslxdff.models["big-pickle"]);
  });

  test("corrupted json -> backup .bak and recreate", async () => {
    const file = tmpFile();
    writeFileSync(file, "bad json {");
    const { syncToOpencode } = await import("../src/sync-opencode.js");
    const r = await syncToOpencode({ id: "deepseek-v4-flash-free", token: "tok", port: 8989, file });
    assert.equal(r.corrupted, true);
    assert.ok(existsSync(file + ".bak"));
    assert.equal(readFileSync(file + ".bak", "utf8"), "bad json {");
    const data = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(data.provider.mslxdff.models["deepseek-v4-flash-free"]);
  });

  test("prune: 未在 keep 中的旧模型被摘除（含 legacy 前缀与 slash 键）", async () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({
      provider: {
        mslxdff: { npm: "@ai-sdk/openai-compatible", name: "mslxdff", options: { baseURL: "http://127.0.0.1:8989/v1", apiKey: "old" }, models: {
          "keep-me": { name: "keep-me" },
          "drop-me": { name: "drop-me" },
          "mslxdff-stale-legacy": { name: "mslxdff-stale-legacy" },
          "bai/deepseek-v4-flash": { name: "x" },
        } }
      }
    }, null, 2));
    const { syncToOpencode } = await import("../src/sync-opencode.js");
    const r = await syncToOpencode({ id: "keep-me", token: "tok", port: 8989, file, keep: ["keep-me", "bai/deepseek-v4-flash"] });
    assert.equal(r.pruned, 2);
    const data = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(Object.keys(data.provider.mslxdff.models).sort(), ["bai/deepseek-v4-flash", "keep-me"]);
  });

  test("prune: 不传 keep 则一个不动（向后兼容）", async () => {
    const file = tmpFile();
    const { syncToOpencode } = await import("../src/sync-opencode.js");
    await syncToOpencode({ id: "keep-me", token: "tok", port: 8989, file });
    const r = await syncToOpencode({ id: "other", token: "tok", port: 8989, file });
    assert.equal(r.pruned, 0);
    const data = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(Object.keys(data.provider.mslxdff.models).sort(), ["keep-me", "other"]);
  });

  test("isOpencodeLocalUrl", async () => {
    const { isOpencodeLocalUrl } = await import("../src/sync-opencode.js");
    assert.equal(isOpencodeLocalUrl("http://127.0.0.1:8989/v1"), true);
    assert.equal(isOpencodeLocalUrl("http://127.0.0.1:8089/v1/chat/completions"), true);
    assert.equal(isOpencodeLocalUrl("http://localhost:8989/v1"), false);
    assert.equal(isOpencodeLocalUrl("https://example.com/v1"), false);
  });
});

describe("sync-opencode ensureAll（picks 全量补齐，修 pick 了却不见 + 列表越积越多）", () => {
  test("US1: ensureAll 补齐 picks 缺失键（backfilled 计数）", async () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({
      provider: { mslxdff: { npm: "@ai-sdk/openai-compatible", name: "mslxdff", options: { baseURL: "http://127.0.0.1:8989/v1", apiKey: "old" }, models: {
        "big-pickle": { name: "big-pickle" },
        "muse-spark-1.2-contributor-free": { name: "muse-spark-1.2-contributor-free" },
      } } }
    }, null, 2));
    const { syncToOpencode } = await import("../src/sync-opencode.js");
    const r = await syncToOpencode({
      id: "big-pickle", token: "tok", port: 8989, file,
      keep: ["big-pickle", "muse-spark-1.2-contributor-free", "muse-spark-1.3-contributor-free"],
      ensureAll: ["big-pickle", "muse-spark-1.2-contributor-free", "muse-spark-1.3-contributor-free"],
    });
    assert.equal(r.backfilled, 1);
    const data = JSON.parse(readFileSync(file, "utf8"));
    const keys = Object.keys(data.provider.mslxdff.models).sort();
    assert.deepEqual(keys, ["big-pickle", "muse-spark-1.2-contributor-free", "muse-spark-1.3-contributor-free"]);
  });

  test("US2: ensureAll+keep 联动，picks 外旧键仍被移除", async () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({
      provider: { mslxdff: { npm: "@ai-sdk/openai-compatible", name: "mslxdff", options: { baseURL: "http://127.0.0.1:8989/v1", apiKey: "old" }, models: {
        "keep-me": { name: "keep-me" },
        "stale-old": { name: "stale-old" },
      } } }
    }, null, 2));
    const { syncToOpencode } = await import("../src/sync-opencode.js");
    const r = await syncToOpencode({
      id: "keep-me", token: "tok", port: 8989, file,
      keep: ["keep-me"], ensureAll: ["keep-me"],
    });
    assert.equal(r.pruned, 1);
    assert.equal(r.backfilled, 0);
    const data = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(Object.keys(data.provider.mslxdff.models), ["keep-me"]);
  });

  test("US3: 当前 id 不在 ensureAll/keep 也保留", async () => {
    const file = tmpFile();
    const { syncToOpencode } = await import("../src/sync-opencode.js");
    const r = await syncToOpencode({
      id: "fresh-choice", token: "tok", port: 8989, file,
      keep: ["other"], ensureAll: ["other"],
    });
    const data = JSON.parse(readFileSync(file, "utf8"));
    const keys = Object.keys(data.provider.mslxdff.models).sort();
    assert.deepEqual(keys, ["fresh-choice", "other"]);
    assert.equal(r.backfilled, 1, "other 由 ensureAll 补齐");
  });

  test("US4: keep/ensureAll 为 null 时不补齐不剪枝（向后兼容）", async () => {
    const file = tmpFile();
    const { syncToOpencode } = await import("../src/sync-opencode.js");
    await syncToOpencode({ id: "keep-me", token: "tok", port: 8989, file });
    const r = await syncToOpencode({ id: "other", token: "tok", port: 8989, file, keep: null, ensureAll: null });
    assert.equal(r.pruned, 0);
    assert.equal(r.backfilled, 0);
    const data = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(Object.keys(data.provider.mslxdff.models).sort(), ["keep-me", "other"]);
  });

  test("US5: ensureAll 里 slash 形态 → dash 键落盘 + alias 注册", async () => {
    const file = tmpFile();
    const { syncToOpencode } = await import("../src/sync-opencode.js");
    await syncToOpencode({
      id: "big-pickle", token: "tok", port: 8989, file,
      keep: ["big-pickle", "workbuddy/deepseek-v4-flash"],
      ensureAll: ["big-pickle", "workbuddy/deepseek-v4-flash"],
    });
    const data = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(data.provider.mslxdff.models["workbuddy-deepseek-v4-flash"], "slash pick 应落 dash 键");
    const { getModelAlias } = await import("../src/providers/model-id.js");
    assert.equal(getModelAlias("workbuddy-deepseek-v4-flash"), "workbuddy/deepseek-v4-flash");
  });

  test("US6: 幂等——第二次调用 backfilled=0 无重复键", async () => {
    const file = tmpFile();
    const { syncToOpencode } = await import("../src/sync-opencode.js");
    const picks = ["big-pickle", "muse-spark-1.3-contributor-free"];
    await syncToOpencode({ id: "big-pickle", token: "tok", port: 8989, file, keep: picks, ensureAll: picks });
    const r2 = await syncToOpencode({ id: "big-pickle", token: "tok", port: 8989, file, keep: picks, ensureAll: picks });
    assert.equal(r2.backfilled, 0);
    const data = JSON.parse(readFileSync(file, "utf8"));
    const keys = Object.keys(data.provider.mslxdff.models).sort();
    assert.deepEqual(keys, ["big-pickle", "muse-spark-1.3-contributor-free"]);
  });
});
