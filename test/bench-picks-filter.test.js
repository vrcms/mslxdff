import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { filterBenchModels } from "../src/cli/commands/provider/bench-via.js";

function mockOk(json) {
  return { ok: true, status: 200, text: async () => JSON.stringify(json), json: async () => json, headers: { get: () => "application/json" } };
}
const mockChatOk = () => mockOk({ choices: [{ message: { content: "hi there" } }], usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 } });

function stubProcess() {
  const st = { logs: [], errors: [], exitCode: null, origExit: process.exit, origLog: console.log, origError: console.error };
  process.exit = (c) => { st.exitCode = c; throw new Error(`exit:${c}`); };
  console.log = (...a) => st.logs.push(a.join(" "));
  console.error = (...a) => st.errors.push(a.join(" "));
  return st;
}
function restoreProcess(st) {
  process.exit = st.origExit;
  console.log = st.origLog;
  console.error = st.origError;
}
async function withTmpState(obj, fn) {
  const fs = await import("node:fs/promises");
  const tmp = `C:\\Users\\mslxd\\AppData\\Local\\Temp\\opencode\\state-picks-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`;
  await fs.writeFile(tmp, JSON.stringify(obj));
  const origEnv = process.env.MSLXDFF_STATE_FILE;
  const origDelay = process.env.MSLXDFF_BENCH_DELAY_MS;
  process.env.MSLXDFF_STATE_FILE = tmp;
  process.env.MSLXDFF_BENCH_DELAY_MS = "0";
  const { clearStateCache } = await import("../src/state/store.js");
  clearStateCache();
  try {
    return await fn();
  } finally {
    process.env.MSLXDFF_STATE_FILE = origEnv;
    if (origDelay === undefined) delete process.env.MSLXDFF_BENCH_DELAY_MS;
    else process.env.MSLXDFF_BENCH_DELAY_MS = origDelay;
    clearStateCache();
    try { await fs.unlink(tmp); } catch {}
  }
}

describe("filterBenchModels", () => {
  it("picks 为空时原样通过（兼容纯 allowlist 用户）", () => {
    const r = filterBenchModels({ providerId: "bai", allowed: ["a", "b"], picks: [] });
    assert.deepEqual(r.models, ["a", "b"]);
    assert.equal(r.skippedUnpicked, 0);
  });

  it("有 picks 时只留交集", () => {
    const r = filterBenchModels({ providerId: "bai", allowed: ["deepseek-v4-flash", "glm-5.3-flash"], picks: ["bai/glm-5.3-flash"] });
    assert.deepEqual(r.models, ["glm-5.3-flash"]);
    assert.equal(r.skippedUnpicked, 1);
    assert.deepEqual(r.pickedBlocked, []);
  });

  it("已勾选但未进 allowlist 进 pickedBlocked", () => {
    const r = filterBenchModels({ providerId: "workbuddy", allowed: ["deepseek-v4-flash"], picks: ["workbuddy/hy4-preview"] });
    assert.deepEqual(r.models, []);
    assert.deepEqual(r.pickedBlocked, ["workbuddy/hy4-preview"]);
  });

  it("opencode 裸 picks 在 allowAny 下可测", () => {
    const r = filterBenchModels({ providerId: "opencode", allowed: [], picks: ["big-pickle", "workbuddy/hy3"], allowAny: true });
    assert.deepEqual(r.models, ["big-pickle"]);
  });
});

describe("bench picks 过滤（集成）", () => {
  let st;
  beforeEach(() => { st = stubProcess(); });
  afterEach(() => restoreProcess(st));

  it("普通 bench 只打已勾选模型", async () => {
    const { handleProviderBench } = await import("../src/cli/commands/provider/bench.js");
    const probed = [];
    const deps = {
      loadProviderConfigs: () => ({ tp: { baseUrl: "https://a.com" } }),
      loadProviderKeys: () => ["k"],
      loadProviderAllowedModels: () => ["m-pick", "m-skip"],
      loadProviderAllowAnyModels: () => false,
      loadProviderBaseUrl: () => "https://a.com",
      loadModelPicks: () => ["tp/m-pick"],
      fetchImpl: async (url, init) => { probed.push(JSON.parse(init.body).model); return mockChatOk(); },
    };
    await withTmpState({}, async () => {
      await assert.rejects(() => handleProviderBench("tp", "bench", ["bench", "--json"], [], deps), /exit:0/);
    });
    assert.equal(st.exitCode, 0);
    assert.deepEqual(probed, ["m-pick"]);
  });

  it("bench --via 全量只测交集", async () => {
    const { handleProviderBench } = await import("../src/cli/commands/provider/bench.js");
    const deps = {
      loadProviderConfigs: () => ({ tp: { baseUrl: "https://a.com" } }),
      loadProviderKeys: () => ["k"],
      loadProviderAllowedModels: () => ["m-pick", "m-skip"],
      loadProviderAllowAnyModels: () => false,
      loadProviderBaseUrl: () => "https://a.com",
      loadModelPicks: () => ["tp/m-pick"],
      getOnlinePeers: async () => [{ id: "p1", url: "http://peer1:8989", name: "p1" }],
      fetchImpl: async () => mockChatOk(),
    };
    let report = null;
    await withTmpState({}, async () => {
      await assert.rejects(() => handleProviderBench("bench", "bench", ["bench", "--via", "--json"], [], deps), /exit:0/);
      const out = st.logs.join("\n");
      report = JSON.parse(out.slice(out.indexOf("{")));
    });
    assert.equal(st.exitCode, 0);
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].model, "m-pick");
  });
});
