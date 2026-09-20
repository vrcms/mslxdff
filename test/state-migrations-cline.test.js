import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readState, writeStateImmediate } from "../src/state/store.js";
import { clineUnifyMigration } from "../src/state/migrations/cline-unify.js";
import { runStateMigrations } from "../src/state/migrations.js";

// 事件日志落临时目录，绝不碰真实 ~/.config/mslxdff（迁移测试也不得动真实 state）
process.env.MSLXDFF_DAEMON_DIR = mkdtempSync(join(tmpdir(), "mslxdff-cline-mig-log-"));

const RT_1 = "refresh-token-account-1-abcdefghijklmnop";
const RT_2 = "refresh-token-account-2-abcdefghijklmnop";
const LEGACY_SK = "sk_legacy_should_be_dropped";

function mkState(providerConfigs) {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-cline-mig-"));
  const file = join(dir, "state.json");
  writeStateImmediate(file, { providerConfigs });
  return { dir, file };
}
const cfgOf = (file, id) => readState(file).providerConfigs?.[id];
const backups = (dir) => readdirSync(dir).filter((f) => f.includes(".bak-"));

test("cline-unify: 合并旧 id 到 cline（keys 去重 + sk_ 剔除 + allowlist 求并 + baseUrl 归一含 /api/v1 + 备份）", () => {
  const { dir, file } = mkState({
    cline: { baseUrl: "https://api.cline.bot", keys: [RT_1], allowedModels: ["cline/z-ai/glm-5.3-flash"] },
    clinebot: {
      baseUrl: "https://api.cline.bot/api/v1",
      keys: [RT_2, LEGACY_SK],
      allowedModels: ["z-ai/glm-5.3-flash", "meta/muse-spark-1.3-contributor"],
    },
  });
  try {
    const r = clineUnifyMigration({ file });
    assert.equal(r.applied, true);
    assert.deepEqual(r.before, { keys: 3, allowedModels: 3 });
    assert.deepEqual(r.after, { keys: 2, allowedModels: 2 });
    const cl = cfgOf(file, "cline");
    assert.equal(cfgOf(file, "clinebot"), undefined, "旧 id 键必须删除");
    assert.equal(cl.baseUrl, "https://api.cline.bot/api/v1", "baseUrl 必须自带 /api/v1（否则 chat 拼成 .../chat/completions → 上游 404）");
    assert.deepEqual(cl.keys, [RT_1, RT_2], "keys 去重合并，sk_ 形态剔除");
    assert.deepEqual(cl.allowedModels, ["z-ai/glm-5.3-flash", "meta/muse-spark-1.3-contributor"], "allowlist 存裸 id");
    assert.ok(r.backup && existsSync(r.backup), "必须留同目录备份");
    assert.equal(JSON.parse(readFileSync(r.backup, "utf8")).providerConfigs.clinebot.keys.length, 2, "备份保留迁移前内容");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cline-unify: 幂等（第二次运行 no-op，state 字节不变）", () => {
  const { dir, file } = mkState({ clinebot: { baseUrl: "https://api.cline.bot/api/v1", keys: [RT_1] } });
  try {
    assert.equal(clineUnifyMigration({ file }).applied, true);
    const after1 = readFileSync(file, "utf8");
    const r2 = clineUnifyMigration({ file });
    assert.equal(r2.applied, false);
    assert.equal(r2.changed, false);
    assert.equal(readFileSync(file, "utf8"), after1, "幂等：第二次不得再写盘");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cline-unify: 干跑只预览（不写盘、不备份、不删旧键）", () => {
  const { dir, file } = mkState({ clinebot: { baseUrl: "https://api.cline.bot/api/v1", keys: [RT_1], allowedModels: ["z-ai/glm-5.3-flash"] } });
  try {
    const before = readFileSync(file, "utf8");
    const r = clineUnifyMigration({ file, dryRun: true });
    assert.equal(r.applied, false);
    assert.equal(r.changed, true);
    assert.equal(r.reason, "dry-run");
    assert.deepEqual(r.after, { keys: 1, allowedModels: 1 });
    assert.equal(readFileSync(file, "utf8"), before, "干跑不得写盘");
    assert.equal(backups(dir).length, 0, "干跑不得备份");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cline-unify: 只有旧 id 时落成 cline（继承 modelsPath），runner 汇总 applied → skipped", async () => {
  const { dir, file } = mkState({
    clinebot: {
      baseUrl: "https://api.cline.bot/api/v1",
      keys: [RT_2],
      allowedModels: ["z-ai/glm-5.3-flash"],
      modelsPath: "/ai/cline/recommended-models",
    },
  });
  try {
    const r1 = await runStateMigrations({ file });
    assert.deepEqual(r1.applied, ["cline-unify"]);
    assert.deepEqual(r1.skipped, []);
    assert.deepEqual(r1.errors, []);
    const cl = cfgOf(file, "cline");
    assert.deepEqual(cl.keys, [RT_2]);
    assert.equal(cl.modelsPath, "/ai/cline/recommended-models", "modelsPath 从旧 id 继承");
    assert.equal(cl.baseUrl, "https://api.cline.bot/api/v1");
    const r2 = await runStateMigrations({ file });
    assert.deepEqual(r2.applied, []);
    assert.deepEqual(r2.skipped, ["cline-unify"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cline-unify: 无旧 id 时 no-op（applied=false，无 before/after）", async () => {
  const { dir, file } = mkState({ openrouter: { baseUrl: "https://openrouter.ai/api/v1", keys: ["sk-x"] } });
  try {
    const r = await runStateMigrations({ file });
    assert.deepEqual(r.applied, []);
    assert.equal(r.details["cline-unify"].applied, false);
    assert.equal(r.details["cline-unify"].before, undefined);
    assert.equal(cfgOf(file, "cline"), undefined, "不得凭空造 cline");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cline-unify: 事件留痕只记计数，不含任何凭据明文", () => {
  const { dir, file } = mkState({ clinebot: { baseUrl: "https://api.cline.bot/api/v1", keys: [RT_1] } });
  try {
    clineUnifyMigration({ file });
    const events = readFileSync(join(process.env.MSLXDFF_DAEMON_DIR, "events.log"), "utf8");
    assert.ok(events.includes("cline-unify-migrated"), "必须留痕");
    assert.ok(!events.includes(RT_1), "事件不得含 token 明文");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cline 硬约束不变式：恒 local-only；残留旧 id 靠 refreshToken 形状兜底不外借", async () => {
  const { classifyProvider } = await import("../src/providers/classify.js");
  const { shouldUseGroupForModel } = await import("../src/state/schemas/use-group.js");
  const { shareableProviderIds } = await import("../src/providers/share-keys.js");
  const { dir, file } = mkState({
    cline: { baseUrl: "https://api.cline.bot", keys: [RT_1] },
    clinebot: { baseUrl: "https://api.cline.bot/api/v1", keys: [RT_2] },
  });
  try {
    assert.equal(classifyProvider("cline"), "local-only");
    assert.equal(classifyProvider("clinebot"), "latency-compare", "旧 id 已不在白名单 → 只剩形状兜底");
    assert.equal(shouldUseGroupForModel("cline/z-ai/glm-5.3-flash", { file }), false);
    assert.equal(shouldUseGroupForModel("clinebot/z-ai/glm-5.3-flash", { file }), false, "别名归一后仍 local-only");
    const shareable = shareableProviderIds({ file });
    assert.ok(!shareable.includes("cline"), "cline 的 key 绝不外借");
    assert.ok(!shareable.includes("clinebot"), "残留旧 id 的 refreshToken 必须被形状兜底排除");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
