// zcode 目录与额度单测（models 服务 / balance 解析 / quota CLI）— TDD 先行。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModelsService } from "../src/providers/zcode/models.js";
import { parseZcodeBalance, fetchZcodeBalance, formatZcodeQuota } from "../src/providers/zcode/quota.js";
import { createZcodeProvider } from "../src/providers/zcode/index.js";
import { handleZcodeQuota } from "../src/cli/commands/provider/zcode-quota.js";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

const mkJwt = () => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.sig`;

// 录制样例：Coding Plan 账号（plans + 每模型 entitlement 的 token 余量）
const BALANCE_OK = {
  code: 0,
  success: true,
  data: {
    plans: [{ plan_id: "coding-plan", name: "Coding Plan", status: "ACTIVE", ends_at: "2026-10-31T00:00:00Z" }],
    balances: [
      { plan_id: "coding-plan", show_name: "GLM-5.3", total_units: 20000000, used_units: 1000000, remaining_units: 19000000, unit_type: "token", period_end: "2026-10-31T00:00:00Z" },
      { plan_id: "coding-plan", show_name: "GLM-5.3-Flash", total_units: 20000000, used_units: 250000, remaining_units: 19750000, unit_type: "token" },
      { plan_id: "coding-plan", show_name: "GLM-5.2", total_units: 20000000, used_units: 0, remaining_units: 20000000, unit_type: "token" },
      { plan_id: "coding-plan", show_name: "GLM-5-Turbo", total_units: 20000000, used_units: 0, remaining_units: 20000000, unit_type: "token" },
    ],
  },
};
const balanceFetch = (payload = BALANCE_OK) => async (url) => {
  assert.match(String(url), /\/api\/v1\/zcode-plan\/billing\/balance\?app_version=/);
  return json(payload);
};

test("quota: parseZcodeBalance 按套餐分组 + 余量/有效期", () => {
  const out = parseZcodeBalance(BALANCE_OK);
  assert.equal(out.isEmpty, false);
  assert.equal(out.plans.length, 1);
  assert.equal(out.plans[0].name, "Coding Plan");
  assert.equal(out.plans[0].status, "ACTIVE");
  assert.equal(out.plans[0].expire, "2026-10-31T00:00:00Z");
  assert.equal(out.plans[0].items.length, 4);
  const flash = out.plans[0].items.find((i) => i.name === "GLM-5.3-Flash");
  assert.equal(flash.remaining, 19750000);
  assert.equal(flash.total, 20000000);
  assert.equal(flash.unit, "token");
  assert.equal(out.totals.remaining, 78750000, "总余量 = 各 entitlement 之和");
  const text = formatZcodeQuota({ ok: true, parsed: out });
  assert.match(text, /Coding Plan/);
  assert.match(text, /GLM-5\.3-Flash/);
  assert.match(text, /19750000|19\.75M|19,750,000/, "余量进表格");
});

test("quota: 空套餐 → isEmpty + 领取指引（非堆栈）", () => {
  const out = parseZcodeBalance({ code: 0, data: { plans: [], balances: [] } });
  assert.equal(out.isEmpty, true);
  const text = formatZcodeQuota({ ok: true, parsed: out });
  assert.match(text, /无套餐|未领取/);
  assert.match(text, /领取|官方客户端|zcode-switch/);
});

test("quota: 401/1006 → kind=auth + 重登指引", async () => {
  const r1 = await fetchZcodeBalance({ token: "t", fetchImpl: async () => json({ code: 401, msg: "unauthorized" }) });
  assert.equal(r1.ok, false);
  assert.equal(r1.kind, "auth");
  assert.match(formatZcodeQuota(r1), /-provider zcode login/);

  const r2 = await fetchZcodeBalance({ token: "t", fetchImpl: async () => json({ code: 1006, msg: "invalid token" }) });
  assert.equal(r2.kind, "auth");
});

test("quota: 正常取数 → ok + modelIds（供目录 capabilities 过滤）", async () => {
  const r = await fetchZcodeBalance({ token: "t", fetchImpl: balanceFetch() });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.modelIds.includes("GLM-5.3-Flash"), true);
  const seen = [];
  await fetchZcodeBalance({ token: "tok-1", deviceMid: "mid-1", fetchImpl: async (url, opts) => { seen.push({ url: String(url), headers: opts.headers }); return json(BALANCE_OK); } });
  assert.equal(seen[0].headers.Authorization, "Bearer tok-1");
  assert.equal(seen[0].headers["X-Device-Mid"], "mid-1");
});

test("models: 未登录（无 key）→ 空目录，不假装有额度", async () => {
  const p = createZcodeProvider({ apiKeys: [] });
  assert.deepEqual(await p.listModels(), []);
});

test("models: 有账号 → 4 条 canonical 目录 + 价格 0.00 + 免费标注", async () => {
  const p = createZcodeProvider({ apiKeys: ["jwt-1"], fetchImpl: balanceFetch() });
  const list = await p.listModels();
  assert.equal(list.length, 4);
  assert.deepEqual(
    list.map((m) => m.id),
    ["zcode/GLM-5.3", "zcode/GLM-5.3-Flash", "zcode/GLM-5.2", "zcode/GLM-5-Turbo"],
  );
  assert.equal(list[0].price, "0.00");
  assert.equal(list[0].free, true);
  assert.equal(list[0].enable, true);
  assert.deepEqual(list.map((m) => m.mark), ["*", "*", "*", "*"], "可用标注 *（免费额度内）");
});

test("models: balance capabilities 探测过滤（无交集回退全量）", async () => {
  const one = createModelsService({ id: "zcode", hasAccount: () => true, probe: async () => ["glm-5.2"] });
  const list = await one.listModels();
  assert.deepEqual(list.map((m) => m.id), ["zcode/GLM-5.2"]);

  const none = createModelsService({ id: "zcode", hasAccount: () => true, probe: async () => ["unknown-model"] });
  assert.equal((await none.listModels()).length, 4, "探测无交集 → 回退全量目录（不误删）");
  const noAcct = createModelsService({ id: "zcode", hasAccount: () => false });
  assert.deepEqual(await noAcct.listModels(), []);
});

test("quota CLI: 未登录 → 人话提示 + 非零退出；非 zcode/quota 返回 false", async () => {
  const root = mkdtempSync(join(tmpdir(), "zcode-quota-"));
  try {
    const file = join(root, "state.json");
    writeFileSync(file, JSON.stringify({ providerConfigs: {} }), "utf8");
    const logs = [];
    let code = null;
    const handled = await handleZcodeQuota("zcode", "quota", [], { file, log: (m) => logs.push(String(m)), exit: (c) => { code = c; } });
    assert.equal(handled, true);
    assert.equal(code, 1);
    const out = logs.join("\n");
    assert.match(out, /-provider zcode login/);
    assert.ok(!/at Object\.|at file:\/\//.test(out), "不得是原生堆栈");
    assert.equal(await handleZcodeQuota("qoder", "quota", [], {}), false);
    assert.equal(await handleZcodeQuota("zcode", "models", [], {}), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quota CLI: 已登录 → 套餐名/有效期/余量表格（脱敏 token）", async () => {
  const root = mkdtempSync(join(tmpdir(), "zcode-quota2-"));
  try {
    const file = join(root, "state.json");
    const token = mkJwt();
    writeFileSync(file, JSON.stringify({ providerConfigs: { zcode: { keys: [token] } } }), "utf8");
    const logs = [];
    let code = null;
    await handleZcodeQuota("zcode", "quota", [], { file, deviceMid: "mid-1", fetchImpl: balanceFetch(), log: (m) => logs.push(String(m)), exit: (c) => { code = c; } });
    const out = logs.join("\n");
    assert.equal(code, 0);
    assert.match(out, /Coding Plan/);
    assert.match(out, /2026-10-31/, "有效期");
    assert.ok(!out.includes(token), "日志不得含完整 JWT");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
