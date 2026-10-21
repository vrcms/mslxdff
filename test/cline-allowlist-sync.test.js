import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planMerge, planSync, createAllowlistSync, defaultNormalize, isFreeChannelId } from "../src/providers/cline/allowlist-sync.js";
import { createClineProvider } from "../src/providers/cline/index.js";

function tmpFile(name = "state.json") {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-"));
  return join(dir, name);
}

// ---------- 纯函数：planSync（双向收敛，范围仅 free 通道） ----------

test("planSync: free 目录下架即移除，非 free 通道原样保留", () => {
  const cur = [
    "cline-free/deepseek-v4.1-flash", // 已下架 → 移除
    "cline-pass/kimi-k3",             // 付费通道，不在 free 目录是正常 → 保留
    "meta/muse-spark-1.2-contributor",// 手配/别的通道 → 保留
    "cline-free/solar-mini4",         // 仍在上游 → 保留
  ];
  const { next, added, removed } = planSync(cur, ["cline-free/solar-mini4", "cline/reflection/beam-free"], {
    providerId: "cline",
  });
  assert.deepEqual(removed, ["cline-free/deepseek-v4.1-flash"]);
  assert.deepEqual(added, ["reflection/beam-free"]);
  assert.deepEqual(next, [
    "cline-pass/kimi-k3",
    "meta/muse-spark-1.2-contributor",
    "cline-free/solar-mini4",
    "reflection/beam-free",
  ]);
});

test("planSync: 非 free 通道绝不被移除（即使不在上游目录）", () => {
  const cur = ["cline-pass/glm-5.3-flash", "stealth/space-bunny-alpha", "deepseek/deepseek-v4-flash", "z-ai/glm-5.3-flash"];
  const { next, removed } = planSync(cur, ["cline-free/solar-mini4"], { providerId: "cline" });
  assert.deepEqual(removed, []);
  assert.deepEqual(next, [...cur, "cline-free/solar-mini4"], "既有条目顺序不动，新 id 追加尾部");
});

test("planSync: 下架的 :free / -free 变体也识别为 free 通道", () => {
  const cur = ["poolside/laguna-s-2.1:free", "nvidia/nemotron-3.5-lightning-free", "meta/muse-spark-1.3-contributor"];
  const { next, removed } = planSync(cur, ["poolside/laguna-s-2.1-free"], { providerId: "cline" });
  assert.deepEqual(removed, ["poolside/laguna-s-2.1:free", "nvidia/nemotron-3.5-lightning-free"]);
  assert.deepEqual(next, ["meta/muse-spark-1.3-contributor", "poolside/laguna-s-2.1-free"]);
});

test("planSync: 带 provider 前缀的既有条目归一后参与比对", () => {
  const { next, removed, added } = planSync(["cline/cline-free/gone"], ["cline/cline-free/kept"], { providerId: "cline" });
  assert.deepEqual(removed, ["cline-free/gone"]);
  assert.deepEqual(added, ["cline-free/kept"]);
  assert.deepEqual(next, ["cline-free/kept"]);
});

test("planSync: 重复项去重且幂等", () => {
  const r1 = planSync(["cline-free/a", "cline-free/a"], ["cline-free/a", "cline-free/b"], { providerId: "cline" });
  assert.deepEqual(r1.next, ["cline-free/a", "cline-free/b"]);
  assert.deepEqual(r1.added, ["cline-free/b"]);
  const r2 = planSync(r1.next, ["cline-free/a", "cline-free/b"], { providerId: "cline" });
  assert.deepEqual(r2.added, []);
  assert.deepEqual(r2.removed, []);
  assert.deepEqual(r2.next, r1.next);
});

test("isFreeChannelId: 只认 free 命名空间", () => {
  for (const id of ["cline-free/x", "poolside/laguna-s-2.1:free", "nvidia/nemotron-3.5-lightning-free"]) {
    assert.equal(isFreeChannelId(id), true, `${id} 应判 free`);
  }
  for (const id of ["cline-pass/kimi-k3", "stealth/space-bunny-alpha", "deepseek/deepseek-v4-flash", ""]) {
    assert.equal(isFreeChannelId(id), false, `${id} 不应判 free`);
  }
});

// ---------- 纯函数：planMerge（历史并集语义，保留兼容） ----------

test("planMerge: 上游新 id 追加，既有条目一个不删", () => {
  const cur = ["cline-free/deepseek-v4.1-flash", "cline-pass/kimi-k3"];
  const { next, added } = planMerge(cur, [
    "cline/cline-free/deepseek-v4.1-flash", // 已存在（带 provider 前缀，需归一后比较）
    "cline/stealth/space-bunny-alpha",      // 新上架免费
    "cline/cline-free/gemini-3.8-flash",    // 新上架免费
  ], defaultNormalize, "cline");
  assert.deepEqual(added, ["stealth/space-bunny-alpha", "cline-free/gemini-3.8-flash"]);
  assert.deepEqual(next, [
    "cline-free/deepseek-v4.1-flash",
    "cline-pass/kimi-k3",
    "stealth/space-bunny-alpha",
    "cline-free/gemini-3.8-flash",
  ]);
});

test("planMerge: 通道不同即不同 id（cline-pass ≠ cline-free，正是被误拦的根因）", () => {
  const { next, added } = planMerge(["cline-pass/mimo-v2.6-flash"], ["cline/cline-free/mimo-v2.6-flash"], defaultNormalize, "cline");
  assert.deepEqual(added, ["cline-free/mimo-v2.6-flash"]);
  assert.ok(next.includes("cline-pass/mimo-v2.6-flash"), "旧通道条目保留");
  assert.ok(next.includes("cline-free/mimo-v2.6-flash"), "新通道条目并入");
});

test("planMerge: 幂等 + 输入不被污染", () => {
  const cur = ["a/b"];
  const frozen = [...cur];
  const r1 = planMerge(cur, ["a/b", "a/b", "c/d"], defaultNormalize, "cline");
  const r2 = planMerge(r1.next, ["c/d"], defaultNormalize, "cline");
  assert.deepEqual(r1.added, ["c/d"]);
  assert.deepEqual(r2.added, [], "第二次无新增");
  assert.deepEqual(cur, frozen);
});

test("planMerge: 空/非法输入容忍", () => {
  assert.deepEqual(planMerge(undefined, undefined).added, []);
  assert.deepEqual(planMerge([], ["", "  ", null, undefined]).added, []);
  // 非字符串标量按 String 强转保留——与生产 normalizeAllowedModel 完全一致，
  // 不能只在 defaultNormalize 里加严（否则 index.js 注入 normalizeAllowedModel 时行为就分叉了）。
  assert.deepEqual(planMerge([], [42]).added, ["42"]);
});

// ---------- 同步器：写盘节流与异常隔离 ----------

test("allowlistSync: 仅下架（无新增）也必须写盘", () => {
  let written = null;
  const s = createAllowlistSync({
    providerId: "cline",
    loadCurrent: () => ["cline-free/gone", "cline-pass/kimi-k3"],
    persist: (_pid, list) => { written = list; },
    enabled: true,
  });
  const r = s.syncIds([{ id: "cline-free/kept" }]);
  assert.deepEqual(r.removed, ["cline-free/gone"]);
  assert.deepEqual(r.added, ["cline-free/kept"]);
  assert.deepEqual(written, ["cline-pass/kimi-k3", "cline-free/kept"], "下架项被移除且付费通道保留");
});

test("allowlistSync: 无新增且无下架时零写盘", () => {
  let writes = 0;
  const s = createAllowlistSync({
    providerId: "cline",
    loadCurrent: () => ["cline-free/x", "cline-pass/kimi-k3"],
    persist: () => { writes++; },
    enabled: true,
  });
  const r = s.syncIds([{ id: "cline/cline-free/x" }]);
  assert.equal(writes, 0);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.removed, []);
  assert.equal(r.total, 2);
});

test("allowlistSync: 日志同时点名新增与移除", () => {
  const logs = [];
  const s = createAllowlistSync({
    providerId: "cline",
    loadCurrent: () => ["cline-free/gone"],
    persist: () => {},
    onLog: (m) => logs.push(m),
    enabled: true,
  });
  s.syncIds([{ id: "cline-free/new" }]);
  const line = logs.find((l) => l.includes("allowlist auto-sync"));
  assert.ok(line.includes("cline-free/new"), "新增要点名");
  assert.ok(line.includes("cline-free/gone"), "移除要点名");
});

test("allowlistSync: MSLXDFF_CLINE_AUTOSYNC=0 完全跳过（含下架移除）", () => {
  let writes = 0;
  const s = createAllowlistSync({ providerId: "cline", loadCurrent: () => ["cline-free/gone"], persist: () => { writes++; }, enabled: false });
  assert.equal(s.syncIds([{ id: "cline/new-model" }]).skipped, "disabled");
  assert.equal(writes, 0, "关掉后下架项也不能被移除");
});

test("allowlistSync: persist 抛错只记日志，绝不冒泡", () => {
  const logs = [];
  const s = createAllowlistSync({
    providerId: "cline",
    loadCurrent: () => [],
    persist: () => { throw new Error("EACCES state.json"); },
    onLog: (m) => logs.push(m),
    enabled: true,
  });
  const r = s.syncIds([{ id: "cline/cline-free/y" }]);
  assert.equal(r.skipped, "error");
  assert.ok(logs.some((l) => l.includes("EACCES")), "失败要留痕");
});

// ---------- 集成：真 state 文件 + mock 上游 ----------

function mockCatalog({ status = 200, free = [], clinePass = [] } = {}) {
  const calls = { models: 0 };
  async function fetchImpl(url) {
    if (String(url).includes("recommended-models")) {
      calls.models++;
      if (status !== 200) return new Response("upstream down", { status });
      return new Response(JSON.stringify({ free, clinePass }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }
  return { fetchImpl, calls };
}

function readClineCfg(file) {
  return JSON.parse(readFileSync(file, "utf8")).providerConfigs?.cline || {};
}

test("集成：上游新上架免费模型 → 自动进白名单，不再 blocked", async () => {
  const file = tmpFile();
  writeFileSync(file, JSON.stringify({
    providerConfigs: {
      cline: { baseUrl: "https://api.cline.bot", keys: ["sk_legacy_key"], allowAnyModels: false, allowedModels: ["cline-free/deepseek-v4.1-flash"] },
    },
  }));

  const { fetchImpl } = mockCatalog({
    free: [
      { id: "cline-free/deepseek-v4.1-flash" },
      { id: "cline-free/gemini-3.8-flash" },        // 新：上游刚上架
      { id: "stealth/space-bunny-alpha" },           // 新：上游刚上架
      { id: "cline-free/mimo-v2.6-flash" },          // 新：从 pass 换到 free 通道
    ],
    clinePass: [{ id: "cline-pass/kimi-k3" }],
  });

  const p = createClineProvider({ id: "cline", apiKeys: ["sk_legacy_key"], fetchImpl, file, snapshotPath: tmpFile("cline-free.json") });
  const list = await p.listModels();
  assert.equal(list.length, 5, "上游 5 个模型全部返回");

  const cfg = readClineCfg(file);
  for (const id of ["cline-free/gemini-3.8-flash", "stealth/space-bunny-alpha", "cline-free/mimo-v2.6-flash", "cline-pass/kimi-k3", "cline-free/deepseek-v4.1-flash"]) {
    assert.ok(cfg.allowedModels.includes(id), `auto-sync 应把 ${id} 并进白名单`);
  }
  assert.ok(!cfg.allowedModels.some((m) => String(m).startsWith("cline/")), "落盘必须是裸 id，不得带 provider 前缀");
  assert.equal(cfg.allowAnyModels, false, "allowAnyModels 必须保留（曾因 save 函数重建 cfg 被静默抹掉）");
  assert.deepEqual(cfg.keys, ["sk_legacy_key"], "keys 不受同步影响");
  await p.close?.();
});

test("集成：上游下架免费模型 → 自动移出白名单，cline-pass 与手配条目不受影响", async () => {
  const file = tmpFile();
  writeFileSync(file, JSON.stringify({
    providerConfigs: {
      cline: {
        baseUrl: "https://api.cline.bot",
        keys: ["sk_legacy_key"],
        allowAnyModels: false,
        allowedModels: [
          "cline-free/delisted-a",       // 下架 → 移除
          "cline-free/kept-b",           // 仍在上游 → 保留
          "cline-pass/kimi-k3",          // 付费通道 → 保留
          "stealth/space-bunny-alpha",   // 手配 → 保留
        ],
      },
    },
  }));
  const { fetchImpl } = mockCatalog({ free: [{ id: "cline-free/kept-b" }, { id: "cline-free/new-c" }] });

  const p = createClineProvider({ id: "cline", apiKeys: ["sk_legacy_key"], fetchImpl, file, snapshotPath: tmpFile("cline-free.json") });
  await p.listModels();
  await p.close?.();

  const cfg = readClineCfg(file);
  assert.ok(!cfg.allowedModels.includes("cline-free/delisted-a"), "下架项必须被移除");
  assert.ok(cfg.allowedModels.includes("cline-free/kept-b"), "仍在目录的保留");
  assert.ok(cfg.allowedModels.includes("cline-free/new-c"), "新增项并入");
  assert.ok(cfg.allowedModels.includes("cline-pass/kimi-k3"), "cline-pass 不得被动");
  assert.ok(cfg.allowedModels.includes("stealth/space-bunny-alpha"), "手配条目不得被动");
  assert.equal(cfg.allowAnyModels, false);
  assert.deepEqual(cfg.keys, ["sk_legacy_key"]);
});

test("集成：allowAnyModels=true 不被 auto-sync 抹回 false", async () => {
  const file = tmpFile();
  writeFileSync(file, JSON.stringify({
    providerConfigs: { cline: { baseUrl: "https://api.cline.bot", keys: ["k"], allowAnyModels: true, allowedModels: ["cline-free/a"] } },
  }));
  const { fetchImpl } = mockCatalog({ free: [{ id: "cline-free/b" }] });
  const p = createClineProvider({ id: "cline", apiKeys: ["k"], fetchImpl, file, snapshotPath: tmpFile("cline-free.json") });
  await p.listModels();
  assert.equal(readClineCfg(file).allowAnyModels, true);
  await p.close?.();
});

test("集成：缓存命中不重复写盘（零写放大）", async () => {
  const file = tmpFile();
  writeFileSync(file, JSON.stringify({ providerConfigs: { cline: { baseUrl: "https://api.cline.bot", keys: ["k"], allowedModels: [] } } }));
  const { fetchImpl, calls } = mockCatalog({ free: [{ id: "cline-free/only-one" }] });
  const p = createClineProvider({ id: "cline", apiKeys: ["k"], fetchImpl, file, snapshotPath: tmpFile("cline-free.json") });
  await p.listModels();
  const after1 = readFileSync(file, "utf8");
  const writes1 = JSON.parse(after1).providerConfigs.cline.allowedModels.length;
  await p.listModels();
  await p.listModels();
  assert.equal(readFileSync(file, "utf8"), after1, "后续读取不得再改状态文件");
  assert.equal(calls.models, 1, "10 分钟缓存内只打上游一次");
  assert.equal(writes1, 1);
  await p.close?.();
});

test("集成：上游挂了走内置兜底 → 不污染白名单", async () => {
  const file = tmpFile();
  writeFileSync(file, JSON.stringify({
    providerConfigs: { cline: { baseUrl: "https://api.cline.bot", keys: ["k"], allowedModels: ["cline-free/mine"] } },
  }));
  const { fetchImpl } = mockCatalog({ status: 503 });
  const p = createClineProvider({ id: "cline", apiKeys: ["k"], fetchImpl, file, snapshotPath: tmpFile("cline-free.json") });
  const list = await p.listModels();
  assert.ok(list.length >= 1, "兜底仍要给出可用模型，不影响调用");
  const cfg = readClineCfg(file);
  assert.deepEqual(cfg.allowedModels, ["cline-free/mine"], "兜底常量不是上游真相，绝不写进白名单");
  await p.close?.();
});

// ---------- 缺陷复核补测（code-review 指出） ----------

test("allowlistSync: 真实读 env MSLXDFF_CLINE_AUTOSYNC（非 enabled 参数捷径）", async () => {
  const { createAllowlistSync: factory } = await import("../src/providers/cline/allowlist-sync.js");
  const prev = process.env.MSLXDFF_CLINE_AUTOSYNC;
  try {
    let writes = 0;
    const s = factory({ providerId: "cline", loadCurrent: () => [], persist: () => { writes++; } });

    process.env.MSLXDFF_CLINE_AUTOSYNC = "0";
    assert.equal(s.syncIds([{ id: "cline/new-model" }]).skipped, "disabled", "env=0 必须关");
    assert.equal(writes, 0);

    process.env.MSLXDFF_CLINE_AUTOSYNC = "1";
    assert.notEqual(s.syncIds([{ id: "cline/new-model" }]).skipped, "disabled", "env=1 必须放行");
    assert.equal(writes, 1, "放行时应写盘一次");

    delete process.env.MSLXDFF_CLINE_AUTOSYNC;
    assert.notEqual(s.syncIds([{ id: "cline/another" }]).skipped, "disabled", "未设 env 时默认开");
  } finally {
    if (prev === undefined) delete process.env.MSLXDFF_CLINE_AUTOSYNC;
    else process.env.MSLXDFF_CLINE_AUTOSYNC = prev;
  }
});

test("saveProviderAllowedModels: 仅剩 allowAnyModels 时 clear 不整键删 cfg", async () => {
  const file = tmpFile();
  writeFileSync(file, JSON.stringify({ providerConfigs: { qoder: { allowAnyModels: true, allowedModels: ["some-model"] } } }));
  const state = await import("../src/state.js");
  state.saveProviderAllowedModels("qoder", [], { file });
  const cfgs = JSON.parse(readFileSync(file, "utf8")).providerConfigs;
  assert.ok(cfgs.qoder, "cfg 不应被整键删除，否则「允许任意」连带丢失");
  assert.equal(state.loadProviderAllowAnyModels("qoder", { file }), true, "allowAnyModels 必须存活");
});
