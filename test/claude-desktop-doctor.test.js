// 体检层单测：托管策略判据（reg 输出本地化）、App 签名目录解析、探活四态、参数三分。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectManagedPolicy, readAppCatalogIds, appDataDirOf, probeMessages } from "../src/claude-desktop/doctor.js";
import { splitArgs } from "../src/cli/commands/claude-desktop.js";

const regOut = (name) => [
  "",
  `HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Claude`,
  `    ${name}    REG_SZ    gateway`,
  `    另一个    REG_SZ    值`,
  "",
  `    找到 2 个值`,   // 中文版表头：故意写成中文，验证计数不依赖表头
].join("\r\n");

function fakeRun(map) {
  return (cmd, argv) => {
    const key = String(argv?.[1] || "");
    if (cmd !== "reg") return { status: 1, stdout: "" };
    if (map[key] === undefined) return { status: 1, stdout: "" };
    return { status: 0, stdout: map[key] };
  };
}

test("detectManagedPolicy：机器策略有值 → 本地 configLibrary 会被整体忽略（要明说，不能只报「有策略」）", () => {
  const r = detectManagedPolicy({
    platform: "win32",
    run: fakeRun({ "HKCU\\SOFTWARE": "x", "HKLM\\SOFTWARE\\Policies\\Claude": regOut("inferenceProvider"), "HKCU\\SOFTWARE\\Policies\\Claude": "" }),
  });
  assert.equal(r.managed, true);
  assert.equal(r.machinePolicy, true);
  assert.match(r.source, /HKLM/);
  assert.match(r.note, /不会生效/);
});

test("detectManagedPolicy：只有用户策略有值 → 也算托管源，但机器策略优先规则不适用", () => {
  const r = detectManagedPolicy({
    platform: "win32",
    run: fakeRun({ "HKCU\\SOFTWARE": "x", "HKCU\\SOFTWARE\\Policies\\Claude": regOut("inferenceProvider") }),
  });
  assert.equal(r.managed, true);
  assert.equal(r.machinePolicy, false);
  assert.match(r.source, /HKCU/);
});

test("detectManagedPolicy：两边都没值 → 本地配置生效；reg 不可用要如实说「读不动」而不是「无策略」", () => {
  const clean = detectManagedPolicy({ platform: "win32", run: fakeRun({ "HKCU\\SOFTWARE": "x" }) });
  assert.equal(clean.managed, false);
  assert.match(clean.note, /未见托管策略值/);
  const broken = detectManagedPolicy({ platform: "win32", run: () => ({ status: 1, stdout: "" }) });
  assert.equal(broken.managed, false);
  assert.match(broken.note, /reg\.exe 读不动/);
});

test("detectManagedPolicy：linux 分支只认 root 所有的 managed-settings.json，没有它时如实报本地生效", () => {
  const r = detectManagedPolicy({ platform: "linux", run: () => ({ status: 1, stdout: "" }) });
  assert.match(r.note, /managed-settings\.json/);
  assert.equal(typeof r.managed, "boolean");
});

test("readAppCatalogIds：解 base64 签名目录，只收 claude-* 且跨 surface 去重", () => {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-cat-"));
  try {
    mkdirSync(join(dir, "model-catalog"), { recursive: true });
    const doc = {
      version: 1905,
      surfaces: {
        cc: { model_selector_state: [{ model: "claude-opus-5" }, { model: "claude-sonnet-5" }] },
        chat: { model_selector_state: [{ model: "claude-sonnet-5" }, { model: "gpt-should-be-dropped" }] },
      },
    };
    writeFileSync(join(dir, "model-catalog", "published.json"), JSON.stringify({ documentBytes: Buffer.from(JSON.stringify(doc)).toString("base64") }), "utf8");
    const r = readAppCatalogIds({ appDir: dir });
    assert.equal(r.ok, true);
    assert.equal(r.version, 1905);
    assert.deepEqual(r.ids, ["claude-opus-5", "claude-sonnet-5"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readAppCatalogIds：文件缺失/内容坏 → 不抛错，给人话 error（体检命令要能继续跑）", () => {
  const missing = readAppCatalogIds({ appDir: join(tmpdir(), "mslxdff-not-here-" + Date.now()) });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /还没落模型目录/);
  assert.equal(readAppCatalogIds({}).ok, false);
});

test("appDataDirOf：从 configLibrary 回推到 Claude-3p 根（正斜杠反斜杠都吃）", () => {
  assert.equal(appDataDirOf(join("C:", "AppData", "Local", "Claude-3p", "configLibrary")), join("C:", "AppData", "Local", "Claude-3p"));
  assert.equal(appDataDirOf("/home/u/.config/Claude-3p/configLibrary"), "/home/u/.config/Claude-3p");
});

const fakeRes = ({ status, body, headers = {} }) => ({
  status,
  headers: { get: (k) => headers[k] || null },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

test("probeMessages 200：取 actual-model 头与首段正文（体检表要能看出「槽位真的落到哪个模型了」）", async () => {
  const r = await probeMessages({
    port: 8989, token: "t", model: "claude-sonnet-5",
    fetchImpl: async () => fakeRes({ status: 200, body: { content: [{ type: "text", text: "你好" }] }, headers: { "x-mslxdff-actual-model": "qwenwork/pro" } }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.actualModel, "qwenwork/pro");
  assert.equal(r.text, "你好");
});

test("probeMessages 非 200：状态码与响应体片段照实带回，不吞错误", async () => {
  const r = await probeMessages({ port: 8989, token: "t", model: "x", fetchImpl: async () => fakeRes({ status: 401, body: { error: { message: "bad token" } } }) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.match(r.error, /bad token/);
});

test("probeMessages 网络异常与无 token：走 error 分支，不抛到调用方", async () => {
  const boom = await probeMessages({ port: 1, token: "t", model: "x", fetchImpl: async () => { throw new Error("fetch failed"); } });
  assert.equal(boom.ok, false);
  assert.equal(boom.status, 0);
  assert.match(boom.error, /fetch failed/);
  const notoken = await probeMessages({ port: 8989, token: "", model: "x" });
  assert.match(notoken.error, /无 token/);
});

test("splitArgs：--max/--max-effort/--port 的值绝不当成模型 id（踩过：`--max 3` 把 3 写进槽位）", () => {
  const a = splitArgs(["--max", "3", "qwenwork/pro", "--check"]);
  assert.deepEqual(a.positional, ["qwenwork/pro"]);
  assert.deepEqual(a.flags, ["--max", "--check"]);
  assert.equal(a.values["--max"], "3");
  assert.equal(a.missing, "");
  assert.equal(splitArgs(["--max"]).missing, "--max");
  assert.equal(splitArgs(["--max", "--check"]).missing, "--max");
});
