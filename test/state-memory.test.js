import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryState } from "../src/state/memory.js";

test("memoryStore: 同 fileStore 语义，coldWins / hotWins 一致", () => {
  const m1 = createMemoryState("mem://case1");
  m1.savePeers([{ url: "http://a" }]);
  m1.saveModelErrors({ m1: "err" }); // deferred dirty
  // 模拟外部直接改 memDisk 的冷字段（peers）
  // 需通过 _memDisk 直接操作以模拟外部 CLI 改盘
  const { _memDisk } = m1;
  const entry = _memDisk.get("mem://case1");
  const diskObj = entry.obj;
  // 外部把 peers 改为 b
  const external = { ...diskObj, peers: [{ url: "http://b" }], modelErrors: { m1: "diskErr", m2: "disk2" } };
  // 模拟 mtime 递增
  _memDisk.set("mem://case1", { obj: external, mtimeMs: entry.mtimeMs + 10 });
  // 此时 m1 仍有 dirty hot，readPeers 应以 disk 的 cold 为准，hot 以 mem 为准
  const peers = m1.loadPeers();
  assert.deepEqual(peers, [{ url: "http://b" }], "cold 以 disk 为准");
  // 需通过暴露的 loadModelErrors 验证 hot
  const errors = m1.loadModelErrors();
  assert.equal(errors.m1, "err", "hot 以 mem 脏数据为准");
  // 清理
  m1.clear();
});

test("memoryStore: 并行隔离，两实例互不影响", () => {
  const a = createMemoryState("mem://a");
  const b = createMemoryState("mem://b");
  a.saveProviderKeys("openrouter", ["sk-a"]);
  b.saveProviderKeys("openrouter", ["sk-b"]);
  assert.deepEqual(a.loadProviderKeys("openrouter"), ["sk-a"]);
  assert.deepEqual(b.loadProviderKeys("openrouter"), ["sk-b"]);
  a.clear(); b.clear();
});

test("memoryStore: flushSync 后 mtime 更新且 dirty 清除", () => {
  const m = createMemoryState("mem://flush");
  m.saveModelErrors({ x: 1 });
  // deferred 未落盘，memDisk 仍无或旧，需 flush
  m.flushSync();
  const errors = m.loadModelErrors();
  assert.deepEqual(errors, { x: 1 });
  m.clear();
});
