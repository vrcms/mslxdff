import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { syncToCodex } from "../src/sync-codex.js";

function tmpFile(content = null) {
  const fp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codex-")), "config.toml");
  if (content !== null) fs.writeFileSync(fp, content);
  return fp;
}

describe("syncToCodex", () => {
  test("空文件新建：顶层键 + provider 段 + auth 命令", () => {
    const fp = tmpFile();
    const r = syncToCodex({ id: "big-pickle", port: 8989, file: fp });
    assert.equal(r.action, "inserted");
    const t = fs.readFileSync(fp, "utf8");
    assert.match(t, /model = "big-pickle"/);
    assert.match(t, /model_provider = "mslxdff"/);
    assert.match(t, /\[model_providers\.mslxdff\]/);
    assert.match(t, /base_url = "http:\/\/127\.0\.0\.1:8989\/v1"/);
    assert.match(t, /wire_api = "responses"/);
    assert.match(t, /command = "mslxdff"/);
  });

  test("保留用户原有配置并更新旧段", () => {
    const fp = tmpFile('model = "gpt-5"\n[model_providers.mslxdff]\nname = "old"\nbase_url = "http://127.0.0.1:1/v1"\n\n[mcp_servers.x]\ncommand = "y"\n');
    const r = syncToCodex({ id: "big-pickle", port: 9999, file: fp });
    assert.equal(r.action, "updated");
    const t = fs.readFileSync(fp, "utf8");
    assert.match(t, /model = "big-pickle"/);
    assert.match(t, /base_url = "http:\/\/127\.0\.0\.1:9999\/v1"/);
    assert.ok(!t.includes('"old"'));
    assert.match(t, /\[mcp_servers\.x\]/); // 用户段保留
  });

  test("auth 命令：mslxdff 本体运行时写绝对路径（不依赖 PATH）", async () => {
    const { buildAuthCommand, syncToCodex } = await import("../src/sync-codex.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-"));
    const script = path.join(dir, "mslxdff.js");
    fs.writeFileSync(script, "// fake");
    const a = buildAuthCommand({ execPath: process.execPath, argv1: script });
    assert.equal(a.command, process.execPath);
    assert.deepEqual(a.args, [script, "-showtoken"]);
    // 落盘形态：Windows 风格反斜杠走 TOML 单引号
    const fp = path.join(dir, "config.toml");
    syncToCodex({ id: "m", port: 8989, file: fp, auth: { command: "C:\\x\\node.exe", args: ["C:\\y\\mslxdff.js", "-showtoken"] } });
    const t = fs.readFileSync(fp, "utf8");
    assert.match(t, /command = 'C:\\x\\node\.exe'/);
    assert.match(t, /args = \['C:\\y\\mslxdff\.js', "-showtoken"\]/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("auth 命令：解析失败兜底走 PATH 裸命令", async () => {
    const { buildAuthCommand } = await import("../src/sync-codex.js");
    const a = buildAuthCommand({ execPath: "", argv1: "/nope/other.js" });
    assert.deepEqual(a, { command: "mslxdff", args: ["-showtoken"] });
  });

  test("幂等：跑两次内容稳定", () => {
    const fp = tmpFile();
    syncToCodex({ id: "big-pickle", port: 8989, file: fp });
    const a = fs.readFileSync(fp, "utf8");
    const r2 = syncToCodex({ id: "big-pickle", port: 8989, file: fp });
    assert.equal(r2.action, "updated");
    assert.equal(fs.readFileSync(fp, "utf8"), a);
  });
});
