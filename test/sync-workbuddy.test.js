import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), "wb-sync-"));
  return join(dir, "models.json");
}

describe("sync-workbuddy core", () => {
  test("empty file -> inserts target entry with local url and token", async () => {
    const file = tmpFile();
    const { syncToWorkbuddy } = await import("../src/sync-workbuddy.js");
    const r = await syncToWorkbuddy({ id: "deepseek-v4-flash-free", token: "tok123", port: 8989, file });
    assert.equal(r.action, "inserted");
    const arr = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(arr.length, 1);
    const m = arr[0];
    assert.equal(m.id, "deepseek-v4-flash-free");
    assert.equal(m.name, "deepseek-v4-flash-free");
    assert.equal(m.url, "http://127.0.0.1:8989/v1/chat/completions");
    assert.equal(m.apiKey, "tok123");
    assert.equal(m.vendor, "Custom");
  });

  test("existing local entry with different id -> inserts new, preserves old (guarantee existence)", async () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify([
      { id: "big-pickle", name: "big-pickle", vendor: "Custom", url: "http://127.0.0.1:8989/v1/chat/completions", apiKey: "oldtok" },
    ]));
    const { syncToWorkbuddy } = await import("../src/sync-workbuddy.js");
    const r = await syncToWorkbuddy({ id: "deepseek-v4-flash-free", token: "newtok", port: 8989, file });
    assert.equal(r.action, "inserted");
    const arr = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(arr.length, 2, "should preserve old and insert new");
    const old = arr.find((m) => m.id === "big-pickle");
    assert.ok(old, "old entry preserved");
    assert.equal(old.apiKey, "oldtok");
    const inserted = arr.find((m) => m.id === "deepseek-v4-flash-free");
    assert.ok(inserted);
    assert.equal(inserted.apiKey, "newtok");
    assert.equal(inserted.url, "http://127.0.0.1:8989/v1/chat/completions");
  });

  test("existing target entry with old token -> updates token and port", async () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify([
      { id: "deepseek-v4-flash-free", name: "deepseek-v4-flash-free", vendor: "Custom", url: "http://127.0.0.1:8989/v1/chat/completions", apiKey: "oldtok", supportsToolCall: true },
    ]));
    const { syncToWorkbuddy } = await import("../src/sync-workbuddy.js");
    const r = await syncToWorkbuddy({ id: "deepseek-v4-flash-free", token: "newtok", port: 18989, file });
    assert.equal(r.action, "updated");
    const arr = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(arr[0].apiKey, "newtok");
    assert.equal(arr[0].url, "http://127.0.0.1:18989/v1/chat/completions");
    assert.equal(arr[0].supportsToolCall, true, "should preserve custom fields");
  });

  test("non-local entries are preserved", async () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify([
      { id: "mimo-v2.5-free", name: "mimo-v2.5-free", vendor: "Custom", url: "https://jpt.dabeizi.com/v1/chat/completions", apiKey: "sk-xxx" },
      { id: "other-free", name: "other", vendor: "Custom", url: "https://example.com/v1/chat/completions", apiKey: "k2" },
    ]));
    const { syncToWorkbuddy } = await import("../src/sync-workbuddy.js");
    await syncToWorkbuddy({ id: "big-pickle", token: "tok", port: 8989, file });
    const arr = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(arr.length, 3);
    const mimo = arr.find((m) => m.id === "mimo-v2.5-free");
    assert.ok(mimo);
    assert.equal(mimo.apiKey, "sk-xxx", "non-local apiKey must not change");
    assert.equal(mimo.url, "https://jpt.dabeizi.com/v1/chat/completions");
  });

  test("illegal JSON -> backup .bak and recreate", async () => {
    const file = tmpFile();
    writeFileSync(file, "bad json {");
    const { syncToWorkbuddy } = await import("../src/sync-workbuddy.js");
    await syncToWorkbuddy({ id: "big-pickle", token: "tok", port: 8989, file });
    assert.ok(existsSync(file + ".bak"), "should backup corrupted file");
    const bak = readFileSync(file + ".bak", "utf8");
    assert.equal(bak, "bad json {");
    const arr = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(arr.length, 1);
    assert.equal(arr[0].id, "big-pickle");
  });

  test("directory not exists -> mkdir -p", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-missing-"));
    const file = join(dir, "nested", "deep", "models.json");
    const { syncToWorkbuddy } = await import("../src/sync-workbuddy.js");
    await syncToWorkbuddy({ id: "big-pickle", token: "tok", port: 8989, file });
    assert.ok(existsSync(file));
    const arr = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(arr[0].id, "big-pickle");
  });

  test("buildWorkbuddyEntry creates correct shape", async () => {
    const { buildWorkbuddyEntry } = await import("../src/sync-workbuddy.js");
    const e = buildWorkbuddyEntry({ id: "laguna-s-2.1-free", token: "t", port: 8989 });
    assert.equal(e.id, "laguna-s-2.1-free");
    assert.equal(e.url, "http://127.0.0.1:8989/v1/chat/completions");
    assert.equal(e.apiKey, "t");
    assert.equal(e.vendor, "Custom");
    assert.equal(e.supportsToolCall, true);
  });

  test("isLocalUrl detects 127.0.0.1 only (per spec)", async () => {
    const { isLocalUrl } = await import("../src/sync-workbuddy.js");
    assert.equal(isLocalUrl("http://127.0.0.1:8989/v1/chat/completions"), true);
    assert.equal(isLocalUrl("http://localhost:8989/v1/chat/completions"), false, "localhost not considered local per 127.0.0.1 spec");
    assert.equal(isLocalUrl("https://jpt.dabeizi.com/v1/chat/completions"), false);
    assert.equal(isLocalUrl("http://149.13.91.10:8989/v1/chat/completions"), false);
    assert.equal(isLocalUrl("http://localhost:8089/v1/chat/completions"), false);
  });

  test("prune: 本地失效条目摘除，非本地条目不动", async () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify([
      { id: "keep-me", name: "keep-me", vendor: "Custom", url: "http://127.0.0.1:8989/v1/chat/completions", apiKey: "t" },
      { id: "stale-local", name: "stale-local", vendor: "Custom", url: "http://127.0.0.1:8989/v1/chat/completions", apiKey: "t" },
      { id: "foreign", name: "foreign", vendor: "Custom", url: "https://example.com/v1/chat/completions", apiKey: "k" },
    ]));
    const { syncToWorkbuddy } = await import("../src/sync-workbuddy.js");
    const r = await syncToWorkbuddy({ id: "keep-me", token: "t", port: 8989, file, keep: ["keep-me"] });
    assert.equal(r.pruned, 1);
    const arr = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(arr.map((m) => m.id).sort(), ["foreign", "keep-me"]);
  });

  test("prune: picks 里 slash 形态与存储 dash 形态互认", async () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify([
      { id: "bai-deepseek-v4-flash", name: "x", vendor: "Custom", url: "http://127.0.0.1:8989/v1/chat/completions", apiKey: "t", _mslxdffOriginalId: "bai/deepseek-v4-flash" },
    ]));
    const { syncToWorkbuddy } = await import("../src/sync-workbuddy.js");
    const r = await syncToWorkbuddy({ id: "bai/deepseek-v4-flash", token: "t", port: 8989, file, keep: ["bai/deepseek-v4-flash"] });
    assert.equal(r.pruned, 0);
    const arr = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(arr.length, 1);
  });

  test("idempotent second sync does not duplicate", async () => {
    const file = tmpFile();
    const { syncToWorkbuddy } = await import("../src/sync-workbuddy.js");
    await syncToWorkbuddy({ id: "deepseek-v4-flash-free", token: "tok", port: 8989, file });
    await syncToWorkbuddy({ id: "deepseek-v4-flash-free", token: "tok", port: 8989, file });
    const arr = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(arr.length, 1);
  });
});
