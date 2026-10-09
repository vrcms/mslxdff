// -setto claude 写入器单测：只动网关相关键、备份一次性、损坏拒写、幂等原子落盘。
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSettingsPath, buildClaudeSettings, syncToClaude } from "../src/sync-claude.js";

let dir;
const USER_SETTINGS = {
  permissions: { allow: ["Bash(npm run lint)"] },
  env: { MY_CUSTOM: "keep-me", ANTHROPIC_MODEL: "should-be-removed" },
  model: "old-model",
  hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] },
  tui: { theme: "dark" },
};

before(() => { dir = mkdtempSync(join(tmpdir(), "mslxdff-sync-claude-")); });
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const CTX = { baseUrl: "http://127.0.0.1:8989", token: "t".repeat(64), model: "qwenwork/qwork-auto" };

describe("claudeSettingsPath", () => {
  test("默认 ~/.claude/settings.json；CLAUDE_CONFIG_DIR 优先", () => {
    const home = process.env.USERPROFILE || process.env.HOME;
    const prev = process.env.CLAUDE_CONFIG_DIR;
    try {
      delete process.env.CLAUDE_CONFIG_DIR;
      assert.match(claudeSettingsPath(), /[\\/]\.claude[\\\/]settings\.json$/);
      assert.ok(claudeSettingsPath().startsWith(home.slice(0, 8)));
      process.env.CLAUDE_CONFIG_DIR = join(dir, "cfg");
      assert.equal(claudeSettingsPath(), join(dir, "cfg", "settings.json"));
    } finally { if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev; }
  });
});

describe("buildClaudeSettings — 纯函数改键面", () => {
  test("只动我们的键，hooks/permissions/tui 与无关 env 原样保留", () => {
    const out = buildClaudeSettings(JSON.parse(JSON.stringify(USER_SETTINGS)), CTX);
    assert.deepEqual(out.permissions, USER_SETTINGS.permissions);
    assert.deepEqual(out.hooks, USER_SETTINGS.hooks);
    assert.deepEqual(out.tui, USER_SETTINGS.tui);
    assert.equal(out.env.MY_CUSTOM, "keep-me");
    assert.equal(out.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8989");
    assert.equal(out.model, "qwenwork/qwork-auto");
    // 键序也是契约：只覆盖既有键，新键只允许追加尾部（用户手写的键序不许被重排）
    assert.deepEqual(Object.keys(out), [...Object.keys(USER_SETTINGS), "modelPicker"], "其余键保持原顺序，modelPicker 追加在尾");
    assert.deepEqual(Object.keys(out.env), [...Object.keys(USER_SETTINGS.env), "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_ATTRIBUTION_HEADER", "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"].filter((k) => k !== "ANTHROPIC_MODEL"), "env 内既有键序不变，新键追加");
  });
  test("ANTHROPIC_MODEL 被删（否则压过 model 键）；BASE_URL 不带 /v1", () => {
    const out = buildClaudeSettings(JSON.parse(JSON.stringify(USER_SETTINGS)), CTX);
    assert.equal("ANTHROPIC_MODEL" in out.env, false);
    assert.ok(!out.env.ANTHROPIC_BASE_URL.includes("/v1"));
  });
  test("三个 Claude Code 行为开关写入；modelPicker.rows 用 id 原文", () => {
    const out = buildClaudeSettings({}, { ...CTX, picks: ["a/x", "b/y"] });
    assert.equal(out.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
    assert.equal(out.env.CLAUDE_CODE_ATTRIBUTION_HEADER, "0");
    assert.equal(out.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, "1");
    assert.deepEqual(out.modelPicker.options, [
      { model: "a/x", label: "a/x", behavesAs: "claude-sonnet-5" },
      { model: "b/y", label: "b/y", behavesAs: "claude-sonnet-5" },
    ]);
  });
  test("picks 为空时回落到单模型", () => {
    const out = buildClaudeSettings({}, CTX);
    assert.deepEqual(out.modelPicker.options, [{ model: CTX.model, label: CTX.model, behavesAs: "claude-sonnet-5" }]);
  });
  test("behavesAs 可覆盖、传空串可关（本机 Claude Code 对未知且无映射的 id 直接拒跑，实测）", () => {
    assert.equal(buildClaudeSettings({}, { ...CTX, behavesAs: "claude-opus-4-8" }).modelPicker.options[0].behavesAs, "claude-opus-4-8");
    assert.equal("behavesAs" in buildClaudeSettings({}, { ...CTX, behavesAs: "" }).modelPicker.options[0], false);
  });
  test("claude-* 前缀的 id 不写 behavesAs（客户端本就认识，标了反而错配能力口径）", () => {
    const out = buildClaudeSettings({}, { ...CTX, picks: ["claude-opus-4-8", "claude.sonnet-6", "vendor/claude-x", "qwenwork/m"] });
    assert.ok(!("behavesAs" in out.modelPicker.options[0]), "claude- 开头 → 不写");
    assert.ok(!("behavesAs" in out.modelPicker.options[1]), "claude. 开头 → 不写");
    assert.equal(out.modelPicker.options[2].behavesAs, "claude-sonnet-5", "claude- 只在开头才算自家 id：vendor/claude-x 仍需映射");
    assert.equal(out.modelPicker.options[3].behavesAs, "claude-sonnet-5");
    const forced = buildClaudeSettings({}, { ...CTX, picks: ["claude-opus-4-8"], behavesAs: "claude-haiku-1" });
    assert.equal(forced.modelPicker.options[0].behavesAs, "claude-haiku-1", "显式 --behaves-as 覆盖豁免");
  });
});

describe("syncToClaude — 落盘语义", () => {
  test("新文件：inserted，无备份", () => {
    const file = join(dir, "case-new", "settings.json");
    const r = syncToClaude({ ...CTX, file });
    assert.equal(r.action, "inserted");
    assert.equal(r.backup, null);
    const j = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(j.model, CTX.model);
    assert.equal(j.env.ANTHROPIC_AUTH_TOKEN, CTX.token);
  });

  test("已有文件首写：备份=原文件内容；再改不覆盖备份", () => {
    const file = join(dir, "case-backup", "settings.json");
    mkdirSync(join(dir, "case-backup"), { recursive: true });
    writeFileSync(file, JSON.stringify(USER_SETTINGS, null, 2));
    const r1 = syncToClaude({ ...CTX, file });
    assert.ok(r1.backup, "首写必须生成备份");
    const backupText = readFileSync(r1.backup, "utf8");
    assert.match(backupText, /"MY_CUSTOM"/);
    // 第二次（参数不同，内容有变化）
    const r2 = syncToClaude({ ...CTX, model: "other/m", file });
    assert.equal(r2.action, "updated");
    assert.equal(r2.backup, null, "备份已存在时不得谎报「本次新备份」");
    assert.equal(readFileSync(join(dir, "case-backup", "settings.pre-mslxdff.json"), "utf8"), backupText, "旧备份内容不被覆盖");
    // 再切回原参数：内容有变化就要重写（幂等由下一个用例专测），备份仍是首写前那份
    const r3 = syncToClaude({ ...CTX, file });
    assert.equal(r3.changed, true);
    assert.equal(r3.backup, null, "第三次仍不重复生成备份");
  });

  test("幂等：同参数二次执行不写字节", () => {
    const file = join(dir, "case-idem", "settings.json");
    mkdirSync(join(dir, "case-idem"), { recursive: true });
    syncToClaude({ ...CTX, file });
    const text1 = readFileSync(file, "utf8");
    utimesSync(file, new Date(2020, 0, 1), new Date(2020, 0, 1));
    const r = syncToClaude({ ...CTX, file });
    assert.equal(r.changed, false);
    assert.equal(readFileSync(file, "utf8"), text1);
    const mtime = statSync(file).mtimeMs;
    assert.ok(mtime < Date.now() - 1000, "mtime 不应被触碰");
  });

  test("坏 JSON：抛错且原文件字节不变、不生成备份", () => {
    const file = join(dir, "case-bad", "settings.json");
    mkdirSync(join(dir, "case-bad"), { recursive: true });
    const broken = '{ "model": "x", hooks: }';
    writeFileSync(file, broken);
    assert.throws(() => syncToClaude({ ...CTX, file }), /解析失败|拒绝覆盖/);
    assert.equal(readFileSync(file, "utf8"), broken, "原文件必须原样保留");
    assert.equal(existsSync(join(dir, "case-bad", "settings.pre-mslxdff.json")), false);
  });

  test("缺 token 或 model 抛错", () => {
    assert.throws(() => syncToClaude({ ...CTX, token: "", file: join(dir, "nope1.json") }), /token/);
    assert.throws(() => syncToClaude({ ...CTX, id: "", file: join(dir, "nope2.json") }), /model/);
  });

  test("写不进去时绝不谎报已同步（目标位置是个目录），且不残留带 token 的 tmp", () => {
    const sub = join(dir, "case-locked");
    mkdirSync(sub, { recursive: true });
    const target = join(sub, "settings.json");
    mkdirSync(target); // 目标是目录 → rename 与直写都会失败
    assert.throws(() => syncToClaude({ ...CTX, file: target }), /无法写入/);
    const leftovers = readdirSync(sub).filter((f) => f !== "settings.json");
    assert.deepEqual(leftovers, [], `残留了临时文件：${leftovers.join(",")}`);
  });
});
