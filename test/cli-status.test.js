import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildProviderRows, formatProviderRow } from "../src/cli/provider-row.js";

function tmpFile(obj) {
  const d = mkdtempSync(join(tmpdir(), "mslxdff-cli-"));
  const f = join(d, "state.json");
  writeFileSync(f, JSON.stringify(obj));
  return f;
}

describe("C6 provider-row 纯函数", () => {
  test("US1 build 聚合 env+file", async () => {
    const f = tmpFile({ providerKeys: { foo: ["k1"] }, providerConfigs: { foo: { baseUrl: "https://x", keys: ["k1"] } } });
    const prev = process.env.MSLXDFF_BAR_KEY;
    process.env.MSLXDFF_BAR_KEY = "kb";
    const { buildProviderRows: build } = await import("../src/cli/provider-row.js");
    // 用 tmp file 构建
    // buildProviderRows 需读 stateFile 内容；我们直接传 file 让其内部 read
    // 为避免读真 state，传 file 参
    const rows = build({ stateFile: f, env: process.env });
    // 清理
    if (prev === undefined) delete process.env.MSLXDFF_BAR_KEY;
    else process.env.MSLXDFF_BAR_KEY = prev;
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes("foo"), `应含 foo, 实 ${ids}`);
    assert.ok(ids.includes("bar"), `应含 bar (env), 实 ${ids}`);
    assert.ok(ids.includes("opencode"), "应含 opencode");
    const foo = rows.find((r) => r.id === "foo");
    assert.equal(foo.baseUrl, "https://x");
    const bar = rows.find((r) => r.id === "bar");
    assert.ok(bar, "bar 存在");
  });

  test("US2 format 展示", () => {
    const row = { id: "openrouter", enabled: true, baseUrl: "https://openrouter.ai/api/v1", keys: ["sk-1234567890"], allowed: ["a", "b", "c"], share: true, authCount: 0, note: "" };
    const s = formatProviderRow(row);
    assert.match(s, /● openrouter/);
    assert.match(s, /enabled/);
    assert.match(s, /sk-…890/);
    assert.match(s, /allow=3/);
    assert.match(s, /share=ON/);
    assert.match(s, /baseUrl=https:\/\/openrouter/);
  });

  test("US3 workbuddy 桩检测", () => {
    const row1 = { id: "workbuddy", enabled: true, baseUrl: "https://copilot.tencent.com", keys: ["k-new"], allowed: [], share: false, authCount: 0, note: "" };
    // build 会把 k-new 判为桩，这里直接测 format 对已标记 note 的展示
    const s1 = formatProviderRow({ ...row1, enabled: false, note: "测试桩 (key=k-new, baseUrl=127.0.0.1) — 请重跑 node workbuddy-token-auto.js 写入真实 JWT" });
    assert.match(s1, /测试桩/);
    assert.match(s1, /○ workbuddy/);
    assert.match(s1, /disabled/);
    const row2 = { id: "workbuddy", enabled: false, baseUrl: "http://127.0.0.1:8080", keys: ["sk-real-123456789012345"], allowed: [], share: false, authCount: 1, note: "测试桩 (key=k-new, baseUrl=127.0.0.1) — 请重跑" };
    const s2 = formatProviderRow(row2);
    assert.match(s2, /测试桩/);
  });

  test("US4 bootstrap 移位", async () => {
    assert.equal(existsSync("src/runtime/bootstrap.js"), true, "runtime/bootstrap.js 应存在");
    const txt = readFileSync("src/cli/bootstrap.js", "utf8");
    assert.match(txt, /export \* from ["']\.\.\/runtime\/bootstrap\.js["']/);
    assert.ok(txt.split("\n").length <= 5, `cli/bootstrap.js 应 ≤5 行，实 ${txt.split("\n").length}`);
  });
});
