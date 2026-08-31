import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tmpStateFile() {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-store-"));
  return join(dir, "state.json");
}

// 默认 FLUSH_MS=500 时 saveModelErrors 为 deferred（dirty），用于测 mtime 合并
// 若 env FLUSH_MS=0 则 dirty 不会保留，合并无意义，故本文件需在 FLUSH_MS!=0 下跑
// 已在 store.js 读取时 env 未设则为 500，满足条件

test("store merge: hot dirty + external cold change (peers/groups/bans) 以 disk 冷为准", async () => {
  const { saveModelErrors, loadPeers, savePeers, clearStateCache, flushStateSync } = await import("../src/state.js");
  const file = tmpStateFile();
  // 1. 初始化 file：先写一个 peers
  savePeers([{ url: "http://a.example", token: "tokA" }], { file });
  flushStateSync(file);
  // 2. 写热数据（deferred，保持 dirty）
  saveModelErrors({ "m1": "err1" }, { file });
  // 此时 store cache 为 dirty，timer 500ms 未触发
  // 3. 外部 CLI 改 file 的冷字段 peers（模拟 CLI 并发修改）
  await new Promise((r) => setTimeout(r, 12));
  const diskBefore = JSON.parse(readFileSync(file, "utf8"));
  const diskModified = { ...diskBefore, peers: [{ url: "http://b.example", token: "tokB" }], groups: { g1: { key: "k1" } } };
  writeFileSync(file, JSON.stringify(diskModified, null, 2));
  // 4. 再次读 peers 应触发 readState 的 dirty+mtime 合并：disk 的 peers/groups 以 disk 为准，mem 的 modelErrors 以 mem 为准
  // loadPeers 会调用 readState
  const peers = loadPeers({ file });
  assert.deepEqual(peers, [{ url: "http://b.example", token: "tokB" }], "cold peers 应以 disk 修改为准，不被 hot dirty 覆盖");
  const { loadGroups, loadModelErrors } = await import("../src/state.js");
  const groups = loadGroups({ file });
  assert.deepEqual(groups, { g1: { key: "k1" } }, "cold groups 以 disk 为准");
  const errors = loadModelErrors({ file });
  assert.deepEqual(errors, { "m1": "err1" }, "hot modelErrors 以 mem 脏数据为准");
  clearStateCache(file);
  flushStateSync(file);
});

test("store merge: hot wins 保留 mem 热数据", async () => {
  const { saveModelLatencies, loadModelLatencies, savePeers, clearStateCache, flushStateSync } = await import("../src/state.js");
  const file = tmpStateFile();
  savePeers([{ url: "http://a.example", token: "tok" }], { file });
  flushStateSync(file);
  saveModelLatencies({ m1: 123 }, { file });
  await new Promise((r) => setTimeout(r, 12));
  const diskBefore = JSON.parse(readFileSync(file, "utf8"));
  // 外部改 disk 的热字段（但 mem dirty 也有热字段，应以 mem 为准）
  const diskModified = { ...diskBefore, modelLatencies: { m1: 999, m2: 456 } };
  writeFileSync(file, JSON.stringify(diskModified, null, 2));
  const lat = loadModelLatencies({ file });
  // 合并后 hot 以 mem 为准：m1 保持 123，m2 来自 disk？ 当前 merge 为 { ...disk, ...mem } + coldWins 以 disk 为准，hot 以 mem 覆盖 disk，所以 m1=123，m2 保留 disk 的 456？ 实际 mem 只有 m1，合并后 m1=123（mem 覆盖），m2=456（disk 保留因 mem 无该键）。这是扩展语义。
  assert.equal(lat.m1, 123, "hot m1 以 mem 为准");
  clearStateCache(file);
});

test("store parallel: 两个 tmp 文件隔离，互不串味", async () => {
  const { saveProviderKeys, loadProviderKeys, saveModelErrors, loadModelErrors, clearStateCache } = await import("../src/state.js");
  const f1 = tmpStateFile();
  const f2 = tmpStateFile();
  saveProviderKeys("openrouter", ["sk-f1"], { file: f1 });
  saveProviderKeys("openrouter", ["sk-f2"], { file: f2 });
  saveModelErrors({ m: "e1" }, { file: f1 });
  saveModelErrors({ m: "e2" }, { file: f2 });
  // 需等待或强制 flush 以落盘（但读走内存亦可验证隔离）
  assert.deepEqual(loadProviderKeys("openrouter", { file: f1 }), ["sk-f1"]);
  assert.deepEqual(loadProviderKeys("openrouter", { file: f2 }), ["sk-f2"]);
  assert.deepEqual(loadModelErrors({ file: f1 }), { m: "e1" });
  assert.deepEqual(loadModelErrors({ file: f2 }), { m: "e2" });
  clearStateCache(f1);
  clearStateCache(f2);
});

test("store cold immediate: savePeers/saveGroups/saveBans 立即落盘且 mtime 更新", async () => {
  const { savePeers, loadPeers, saveGroups, loadGroups, saveBans, loadBans, clearStateCache } = await import("../src/state.js");
  const file = tmpStateFile();
  savePeers([{ url: "http://x" }], { file });
  assert.deepEqual(loadPeers({ file }), [{ url: "http://x" }]);
  const onDisk1 = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(onDisk1.peers, [{ url: "http://x" }]);
  saveGroups({ g: { key: "k" } }, { file });
  assert.deepEqual(loadGroups({ file }), { g: { key: "k" } });
  saveBans({ "1.2.3.4": { fails: 1 } }, { file });
  assert.deepEqual(loadBans({ file }), { "1.2.3.4": { fails: 1 } });
  clearStateCache(file);
});
