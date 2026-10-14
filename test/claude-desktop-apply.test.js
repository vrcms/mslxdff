// applyClaudeDesktop 编排层的 --1m 接线：盘上条目形状 + out.oneM 汇总（IO 全隔离 tmp，evidence 注入不打网络）。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyClaudeDesktop } from "../src/claude-desktop/apply.js";

let dir;
const prevEnv = {};
before(() => {
  dir = mkdtempSync(join(tmpdir(), "mslxdff-cd-apply-"));
  prevEnv.aliases = process.env.MSLXDFF_ALIASES_FILE;
  process.env.MSLXDFF_ALIASES_FILE = join(dir, "model-aliases.json");
});
after(() => {
  if (prevEnv.aliases === undefined) delete process.env.MSLXDFF_ALIASES_FILE;
  else process.env.MSLXDFF_ALIASES_FILE = prevEnv.aliases;
  rmSync(dir, { recursive: true, force: true });
});

const readProfile = (r) => JSON.parse(readFileSync(r.configFile, "utf8"));

test("oneM=off：盘上条目为历史三键形状，无 1M 键，也不查证据", async () => {
  const r = await applyClaudeDesktop({ picks: ["big-1m", "small-free"], port: 8981, token: "t1", dir, oneM: "off" });
  const p = readProfile(r);
  assert.equal(p.inferenceModels.length, 2);
  assert.ok(p.inferenceModels.every((m) => !("supports1m" in m) && !("prefer1m" in m)));
  assert.equal(r.oneM.mode, "off");
  assert.equal(r.oneM.evidenceQueried, false);
});

test("oneM=all：全部打两键、不查证据", async () => {
  const r = await applyClaudeDesktop({ picks: ["small-free"], port: 8982, token: "t1", dir, oneM: "all" });
  const p = readProfile(r);
  assert.equal(p.inferenceModels[0].supports1m, true);
  assert.equal(p.inferenceModels[0].prefer1m, true);
  assert.equal(r.oneM.evidenceQueried, false);
});

test("oneM=auto + 注入证据：≥1M 打标、200K 不打、markedCount 如实", async () => {
  const evidence = { ok: true, contexts: new Map([["big-1m", 1_000_000], ["small-free", 262_144]]) };
  const r = await applyClaudeDesktop({ picks: ["big-1m", "small-free"], port: 8983, token: "t1", dir, oneM: "auto", evidence });
  const p = readProfile(r);
  assert.equal(p.inferenceModels[0].supports1m, true);
  assert.ok(!("supports1m" in p.inferenceModels[1]));
  assert.equal(r.oneM.markedCount, 1);
  assert.equal(r.oneM.evidenceOk, true);
});

test("oneM=auto + 证据失败（全新目录=盘上无既有标）：不打标、写盘仍成功、evidenceOk=false 透出 reason", async () => {
  const r = await applyClaudeDesktop({ picks: ["big-1m"], port: 8984, token: "t1", dir: join(dir, "evfail-fresh"), oneM: "auto", evidence: { ok: false, reason: "ECONNREFUSED" } });
  const p = readProfile(r);
  assert.ok(!("supports1m" in p.inferenceModels[0]));
  assert.equal(r.action, "inserted");
  assert.equal(r.oneM.evidenceOk, false);
  assert.equal(r.oneM.evidenceReason, "ECONNREFUSED");
});

test("oneM=列表：只标 slot/model 命中行、unmatched 透出、不查证据", async () => {
  const r = await applyClaudeDesktop({ picks: ["big-1m", "small-free"], port: 8985, token: "t1", dir, oneM: "claude-opus-5,ghost" });
  const p = readProfile(r);
  assert.ok(!("supports1m" in p.inferenceModels[0]), "行0=claude-sonnet-5 不在列表");
  assert.equal(p.inferenceModels[1].supports1m, true, "行1=claude-opus-5 在列表");
  assert.deepEqual(r.oneM.unmatched, ["ghost"]);
  assert.equal(r.oneM.evidenceQueried, false);
});

test("重复执行同参数：幂等零字节改动（打标键不破坏原文比对）", async () => {
  const args = { picks: ["big-1m"], port: 8986, token: "t1", dir, oneM: "all" };
  const a = await applyClaudeDesktop(args);
  const b = await applyClaudeDesktop(args);
  assert.equal(b.changed, false);
});

test("all→off 重跑：changed 如实报、盘上两键消失（spec《off 回到历史形状》，评审 2 P1#4）", async () => {
  const a = await applyClaudeDesktop({ picks: ["m-off"], port: 8987, token: "t1", dir, oneM: "all" });
  assert.equal(readProfile(a).inferenceModels[0].supports1m, true);
  const b = await applyClaudeDesktop({ picks: ["m-off"], port: 8987, token: "t1", dir, oneM: "off" });
  assert.equal(b.changed, true);
  assert.ok(!("supports1m" in readProfile(b).inferenceModels[0]));
});

test("auto + 网关未启动（真生产路径、不注入 evidence）：查询失败仍写盘成功，且保留盘上既有标＝changed=false（评审 1 P1-2 / 评审 2 P1#3）", async () => {
  const w = await applyClaudeDesktop({ picks: ["big-1m"], port: 1, token: "t1", dir, oneM: "all" });
  assert.equal(readProfile(w).inferenceModels[0].supports1m, true, "预置：port=1 专属配置带标（127.0.0.1:1 必然拒连）");
  const r = await applyClaudeDesktop({ picks: ["big-1m"], port: 1, token: "t1", dir, oneM: "auto" });
  assert.equal(r.oneM.evidenceQueried, true);
  assert.equal(r.oneM.evidenceOk, false);
  assert.equal(r.changed, false, "无证据 → 保留既有标 = 不改字节，网关停机绝不静默抹标");
  assert.equal(readProfile(r).inferenceModels[0].supports1m, true, "盘上标仍在");
});
