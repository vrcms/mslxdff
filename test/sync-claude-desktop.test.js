// -setto claude-desktop 写盘器单测：profile 键面、_meta 合并不吞他人条目、幂等零字节、损坏拒写、摘登记。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  desktopConfigId, buildDesktopProfile, syncToClaudeDesktop, mergeMeta,
  readClaudeDesktopProfile, retireClaudeDesktopProfile, claudeDesktopConfigDir,
} from "../src/sync-claude-desktop.js";
import { planSlots } from "../src/claude-desktop/slots.js";

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), "mslxdff-cd-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

const rows = () => planSlots({ picks: ["qwenwork/pro", "traework/kimi-k3", "flash-free"] }).rows;

test("配置 id 由端口派生且形态合法（重跑原地更新、不堆条目；端口不同即不撞车）", () => {
  assert.equal(desktopConfigId(8989), "00000000-0000-4000-8000-000000008989");
  assert.notEqual(desktopConfigId(8989), desktopConfigId(9000));
});

test("env MSLXDFF_CLAUDE_DESKTOP_DIR 覆盖路径（单测隔离与自定义安装位都靠它）", () => {
  const prev = process.env.MSLXDFF_CLAUDE_DESKTOP_DIR;
  process.env.MSLXDFF_CLAUDE_DESKTOP_DIR = join(dir, "custom");
  assert.equal(claudeDesktopConfigDir(), join(dir, "custom"));
  if (prev === undefined) delete process.env.MSLXDFF_CLAUDE_DESKTOP_DIR;
  else process.env.MSLXDFF_CLAUDE_DESKTOP_DIR = prev;
});

test("profile 键面：provider/credential/scheme/baseUrl 不带 /v1 + inferenceModels 用角色槽", () => {
  const p = buildDesktopProfile({ baseUrl: "http://127.0.0.1:8989", apiKey: "t0k", rows: rows() });
  assert.equal(p.inferenceProvider, "gateway");
  assert.equal(p.inferenceCredentialKind, "static");
  assert.equal(p.inferenceGatewayAuthScheme, "bearer"); // 本仓只认 Authorization: Bearer
  assert.equal(p.inferenceGatewayBaseUrl, "http://127.0.0.1:8989");
  assert.ok(!/\/v1$/.test(p.inferenceGatewayBaseUrl), "baseUrl 不得带 /v1（App 自己拼 /v1/messages）");
  assert.deepEqual(p.inferenceModels[0], { name: "claude-sonnet-5", labelOverride: "qwenwork/pro" });
  assert.equal(p.inferenceModels.length, 3);
});

test("写入：profile + _meta 两份齐、token 落地、二次运行零字节改动", () => {
  const target = join(dir, "lib1");
  const a = syncToClaudeDesktop({ port: 8989, token: "tok-A", rows: rows(), dir: target });
  assert.equal(a.action, "inserted");
  assert.equal(a.changed, true);
  const text = readFileSync(a.configFile, "utf8");
  assert.ok(text.includes("tok-A"));
  assert.equal(JSON.parse(readFileSync(a.metaFile, "utf8")).appliedId, a.id);
  const b = syncToClaudeDesktop({ port: 8989, token: "tok-A", rows: rows(), dir: target });
  assert.equal(b.changed, false, "幂等：目标态未变不得谎报已更新");
  assert.equal(readFileSync(b.configFile, "utf8"), text);
});

test("_meta 合并：App/窗口自建的条目一字不动，只登记自己那条", () => {
  const target = join(dir, "lib2");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "_meta.json"), JSON.stringify({
    appliedId: "0a0e0fba-eca3-4ceb-b0ea-251eae135a85",
    entries: [{ id: "0a0e0fba-eca3-4ceb-b0ea-251eae135a85", name: "Default" }],
  }), "utf8");
  const r = syncToClaudeDesktop({ port: 8989, token: "t", rows: rows(), dir: target });
  const meta = JSON.parse(readFileSync(r.metaFile, "utf8"));
  assert.equal(meta.entries.length, 2);
  assert.ok(meta.entries.some((e) => e.id === "0a0e0fba-eca3-4ceb-b0ea-251eae135a85" && e.name === "Default"), "他人条目必须原样保留");
  assert.equal(meta.appliedId, r.id);
});

test("mergeMeta 纯函数：重复登记只改 name，不重复追加", () => {
  const one = mergeMeta(null, { id: "x", name: "mslxdff:8989" });
  const two = mergeMeta(one, { id: "x", name: "mslxdff:9000" });
  assert.equal(two.entries.length, 1);
  assert.equal(two.entries[0].name, "mslxdff:9000");
  assert.equal(two.appliedId, "x");
});

test("现有 JSON 坏了 → 整体拒写（那是用户在 App 里配过的东西）", () => {
  const target = join(dir, "lib3");
  const ok = syncToClaudeDesktop({ port: 8989, token: "t", rows: rows(), dir: target });
  writeFileSync(ok.metaFile, "{ 坏掉的 json", "utf8");
  assert.throws(() => syncToClaudeDesktop({ port: 8989, token: "t2", rows: rows(), dir: target }), /解析失败，拒绝覆盖/);
  assert.equal(readFileSync(ok.configFile, "utf8").includes("t2"), false, "拒写时 profile 也不得被改");
});

test("readClaudeDesktopProfile 四态：目录空 / 正常 / appliedId 指向不存在的条目", () => {
  const empty = readClaudeDesktopProfile({ dir: join(dir, "nope") });
  assert.equal(empty.exists, false);
  assert.match(empty.error, /目录不存在/);
  const target = join(dir, "lib4");
  const w = syncToClaudeDesktop({ port: 8989, token: "t", rows: rows(), dir: target });
  const good = readClaudeDesktopProfile({ dir: target });
  assert.equal(good.appliedId, w.id);
  assert.equal(good.appliedName, "mslxdff:8989");
  assert.equal(good.profile.inferenceGatewayBaseUrl, "http://127.0.0.1:8989");
  writeFileSync(join(target, "_meta.json"), JSON.stringify({ appliedId: "ghost", entries: [] }), "utf8");
  const ghost = readClaudeDesktopProfile({ dir: target });
  assert.equal(ghost.profile, null);
  assert.match(ghost.error, /读不到|未选/);
});

test("--official 只摘登记不删配置，appliedId 归空；他人条目仍在", () => {
  const target = join(dir, "lib5");
  const w = syncToClaudeDesktop({ port: 8989, token: "t", rows: rows(), dir: target });
  const meta = JSON.parse(readFileSync(w.metaFile, "utf8"));
  meta.entries.push({ id: "someone-else", name: "Default" });
  writeFileSync(w.metaFile, JSON.stringify(meta), "utf8");
  const r = retireClaudeDesktopProfile({ port: 8989, dir: target });
  assert.equal(r.removed, true);
  assert.equal(r.appliedId, "");
  assert.equal(r.remaining, 1);
  assert.ok(existsSync(w.configFile), "配置文件保留（App 里还能手动切回来）");
  const again = retireClaudeDesktopProfile({ port: 8989, dir: target });
  assert.equal(again.action, "unchanged");
});
