import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), "op-sync-"));
  return join(dir, "opencode.json");
}

describe("sync-opencode alias + dedup + original compatible", () => {
  test("toExternalAlias / toInternalId pure", async () => {
    const { toExternalAlias, toInternalId } = await import("../src/sync-opencode.js");
    assert.equal(toExternalAlias("deepseek"), "mslxdff-deepseek");
    assert.equal(toExternalAlias("mslxdff-deepseek"), "mslxdff-deepseek");
    assert.equal(toExternalAlias(""), "");
    assert.equal(toInternalId("mslxdff-deepseek"), "deepseek");
    assert.equal(toInternalId("deepseek"), "deepseek");
    assert.equal(toInternalId("mslxdff-mslxdff-deepseek"), "mslxdff-deepseek", "only strip one layer");
  });

  test("buildOpencodeProvider creates alias key and local url", async () => {
    const { buildOpencodeProvider } = await import("../src/sync-opencode.js");
    const p = buildOpencodeProvider({ id: "deepseek", token: "tok", port: 8989 });
    assert.equal(p.npm, "@ai-sdk/openai-compatible");
    assert.equal(p.name, "mslxdff");
    assert.equal(p.options.baseURL, "http://127.0.0.1:8989/v1");
    assert.equal(p.options.apiKey, "tok");
    assert.ok(p.models["mslxdff-deepseek"], "should use alias key");
    assert.equal(p.models["mslxdff-deepseek"].name, "mslxdff-deepseek");
  });

  test("empty file -> inserted alias", async () => {
    const file = tmpFile();
    const { syncToOpencode } = await import("../src/sync-opencode.js");
    const r = await syncToOpencode({ id: "deepseek", token: "tok1", port: 8989, file });
    assert.equal(r.action, "inserted");
    assert.equal(r.id, "mslxdff-deepseek");
    assert.equal(r.internal, "deepseek");
    const data = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(data.provider.mslxdff);
    assert.equal(data.provider.mslxdff.models["mslxdff-deepseek"].name, "mslxdff-deepseek");
    assert.equal(data.provider.mslxdff.options.baseURL, "http://127.0.0.1:8989/v1");
  });

  test("existing alias second sync is idempotent updated (no duplicate)", async () => {
    const file = tmpFile();
    const { syncToOpencode } = await import("../src/sync-opencode.js");
    await syncToOpencode({ id: "deepseek", token: "tok1", port: 8989, file });
    const r2 = await syncToOpencode({ id: "deepseek", token: "tok1", port: 8989, file });
    assert.equal(r2.action, "updated");
    const data = JSON.parse(readFileSync(file, "utf8"));
    const keys = Object.keys(data.provider.mslxdff.models);
    assert.equal(keys.length, 1);
    assert.ok(keys.includes("mslxdff-deepseek"));
  });

  test("alias already exists, sync with mslxdff-deepseek does not double prefix", async () => {
    const file = tmpFile();
    const { syncToOpencode } = await import("../src/sync-opencode.js");
    await syncToOpencode({ id: "deepseek", token: "tok1", port: 8989, file });
    const r = await syncToOpencode({ id: "mslxdff-deepseek", token: "tok1", port: 8989, file });
    assert.equal(r.action, "updated");
    const data = JSON.parse(readFileSync(file, "utf8"));
    const keys = Object.keys(data.provider.mslxdff.models);
    assert.equal(keys.length, 1);
    assert.ok(!keys.includes("mslxdff-mslxdff-deepseek"), "should not double prefix");
  });

  test("original compatible: pre-existing naked deepseek is considered same logical model (dedup)", async () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({
      provider: {
        mslxdff: {
          npm: "@ai-sdk/openai-compatible",
          name: "mslxdff",
          options: { baseURL: "http://127.0.0.1:8989/v1", apiKey: "old" },
          models: { "deepseek": { name: "deepseek" } }
        }
      }
    }, null, 2));
    const { syncToOpencode } = await import("../src/sync-opencode.js");
    const r = await syncToOpencode({ id: "deepseek", token: "newtok", port: 8989, file });
    assert.equal(r.action, "updated");
    const data = JSON.parse(readFileSync(file, "utf8"));
    const keys = Object.keys(data.provider.mslxdff.models);
    assert.equal(keys.length, 1, "should not create alias duplicate when naked exists (original compatible)");
    assert.ok(keys.includes("deepseek"), "keeps original key, not forced to alias");
    assert.equal(data.provider.mslxdff.options.apiKey, "newtok");
  });

  test("two different models accumulate as two aliases", async () => {
    const file = tmpFile();
    const { syncToOpencode } = await import("../src/sync-opencode.js");
    await syncToOpencode({ id: "deepseek", token: "tok", port: 8989, file });
    await syncToOpencode({ id: "big-pickle", token: "tok", port: 8989, file });
    const data = JSON.parse(readFileSync(file, "utf8"));
    const keys = Object.keys(data.provider.mslxdff.models).sort();
    assert.deepEqual(keys, ["mslxdff-big-pickle", "mslxdff-deepseek"]);
  });

  test("port change updates baseURL", async () => {
    const file = tmpFile();
    const { syncToOpencode } = await import("../src/sync-opencode.js");
    await syncToOpencode({ id: "deepseek", token: "tok1", port: 8989, file });
    await syncToOpencode({ id: "deepseek", token: "tok2", port: 8089, file });
    const data = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(data.provider.mslxdff.options.baseURL, "http://127.0.0.1:8089/v1");
    assert.equal(data.provider.mslxdff.options.apiKey, "tok2");
  });

  test("other providers preserved", async () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({
      provider: {
        groq: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://api.groq.com/openai/v1", apiKey: "gsk" }, models: { "a": { name: "a" } } },
        mslxdff: { npm: "@ai-sdk/openai-compatible", name: "mslxdff", options: { baseURL: "http://127.0.0.1:8989/v1", apiKey: "old" }, models: { "mslxdff-deepseek": { name: "mslxdff-deepseek" } } }
      },
      agent: { "test": { model: "x" } }
    }, null, 2));
    const { syncToOpencode } = await import("../src/sync-opencode.js");
    await syncToOpencode({ id: "big-pickle", token: "tok", port: 8989, file });
    const data = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(data.provider.groq, "other provider preserved");
    assert.ok(data.agent.test, "top-level preserved");
    assert.ok(data.provider.mslxdff.models["mslxdff-deepseek"]);
    assert.ok(data.provider.mslxdff.models["mslxdff-big-pickle"]);
  });

  test("corrupted json -> backup .bak and recreate", async () => {
    const file = tmpFile();
    writeFileSync(file, "bad json {");
    const { syncToOpencode } = await import("../src/sync-opencode.js");
    const r = await syncToOpencode({ id: "deepseek", token: "tok", port: 8989, file });
    assert.equal(r.corrupted, true);
    assert.ok(existsSync(file + ".bak"));
    assert.equal(readFileSync(file + ".bak", "utf8"), "bad json {");
    const data = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(data.provider.mslxdff.models["mslxdff-deepseek"]);
  });

  test("isOpencodeLocalUrl", async () => {
    const { isOpencodeLocalUrl } = await import("../src/sync-opencode.js");
    assert.equal(isOpencodeLocalUrl("http://127.0.0.1:8989/v1"), true);
    assert.equal(isOpencodeLocalUrl("http://127.0.0.1:8089/v1/chat/completions"), true);
    assert.equal(isOpencodeLocalUrl("http://localhost:8989/v1"), false);
    assert.equal(isOpencodeLocalUrl("https://example.com/v1"), false);
  });
});
