import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

describe("bench via CLI", () => {
  let origExit, origLog, origError;
  let logs, errors, exitCode;
  beforeEach(() => {
    logs = []; errors = []; exitCode = null;
    origExit = process.exit;
    origLog = console.log;
    origError = console.error;
    process.exit = (c) => { exitCode = c; throw new Error(`exit:${c}`); };
    console.log = (...a) => logs.push(a.join(" "));
    console.error = (...a) => errors.push(a.join(" "));
  });
  afterEach(() => {
    process.exit = origExit;
    console.log = origLog;
    console.error = origError;
  });

  it("空组 --via 直接空状态 exit 0", async () => {
    const { handleProviderBench } = await import("../src/cli/commands/provider/bench.js");
    const tmp = `C:\\Users\\mslxd\\AppData\\Local\\Temp\\opencode\\state-${Date.now()}-1.json`;
    await import("node:fs/promises").then((m) => m.writeFile(tmp, JSON.stringify({ groupsJoined: [], peers: [] })));
    const origEnv = process.env.MSLXDFF_STATE_FILE;
    process.env.MSLXDFF_STATE_FILE = tmp;
    const { clearStateCache } = await import("../src/state/store.js");
    clearStateCache();
    const deps = {
      loadProviderConfigs: () => ({ openrouter: { baseUrl: "https://api.example.com" } }),
      loadProviderKeys: () => ["sk-1"],
      loadProviderAllowedModels: () => ["m1"],
      loadProviderAllowAnyModels: () => true,
      loadProviderBaseUrl: () => "https://api.example.com",
    };
    try {
      await assert.rejects(() => handleProviderBench("openrouter", "bench", ["bench", "--via"], [], deps), /exit:0/);
      assert.equal(exitCode, 0);
      assert.match(logs.join("\n"), /未加入组/);
    } finally {
      process.env.MSLXDFF_STATE_FILE = origEnv;
      clearStateCache();
      try { await import("node:fs/promises").then((m) => m.unlink(tmp)); } catch {}
    }
  });

  it("--via --json 空组输出 JSON", async () => {
    const { handleProviderBench } = await import("../src/cli/commands/provider/bench.js");
    const tmp = `C:\\Users\\mslxd\\AppData\\Local\\Temp\\opencode\\state-${Date.now()}-2.json`;
    await import("node:fs/promises").then((m) => m.writeFile(tmp, JSON.stringify({ groupsJoined: [], peers: [] })));
    const origEnv = process.env.MSLXDFF_STATE_FILE;
    process.env.MSLXDFF_STATE_FILE = tmp;
    const { clearStateCache } = await import("../src/state/store.js");
    clearStateCache();
    const deps = {
      loadProviderConfigs: () => ({ openrouter: { baseUrl: "https://a.com" } }),
      loadProviderKeys: () => ["k"],
      loadProviderAllowedModels: () => ["m1"],
      loadProviderAllowAnyModels: () => true,
      loadProviderBaseUrl: () => "https://a.com",
    };
    try {
      await assert.rejects(() => handleProviderBench("openrouter", "bench", ["bench", "--via", "--json"], [], deps), /exit:0/);
      const out = logs.join("\n");
      const j = JSON.parse(out);
      assert.equal(j.results.length, 0);
      assert.equal(j.meta.opencodeSkipped, true);
    } finally {
      process.env.MSLXDFF_STATE_FILE = origEnv;
      clearStateCache();
      try { await import("node:fs/promises").then((m) => m.unlink(tmp)); } catch {}
    }
  });

  it("deepseek bench 显式拦截：不发起任何测速，提示改用 health", async () => {
    const { handleProviderBench } = await import("../src/cli/commands/provider/bench.js");
    const deps = {
      loadProviderConfigs: () => ({ deepseek: {} }),
      loadProviderKeys: () => ["tk-x"],
      loadProviderAllowedModels: () => ["deepseek-chat-free"],
      loadProviderAllowAnyModels: () => false,
      loadProviderBaseUrl: () => "https://chat.deepseek.com",
      fetchImpl: async () => { throw new Error("SHOULD_NOT_FETCH"); },
    };
    const r = await handleProviderBench("deepseek", "bench", ["bench", "--json"], [], deps);
    assert.equal(r, true);
    assert.equal(exitCode, null); // 未触发 process.exit（干净跳过）
    const out = logs.join("\n");
    const j = JSON.parse(out);
    assert.equal(j.ok, false);
    assert.equal(j.skipped, "deepseek");
    assert.match(j.advice, /health/);
  });

  it("deepseek bench --via 同样拦截（含 ds 别名）", async () => {
    const { handleProviderBench } = await import("../src/cli/commands/provider/bench.js");
    const deps = {
      loadProviderConfigs: () => ({ deepseek: {} }),
      loadProviderKeys: () => ["tk-x"],
      loadProviderAllowedModels: () => ["deepseek-chat-free"],
      loadProviderAllowAnyModels: () => false,
      loadProviderBaseUrl: () => "https://chat.deepseek.com",
      fetchImpl: async () => { throw new Error("SHOULD_NOT_FETCH"); },
    };
    for (const pid of ["deepseek", "ds"]) {
      logs.length = 0;
      const r = await handleProviderBench(pid, "bench", ["bench", "--via"], [], deps);
      assert.equal(r, true);
      assert.match(logs.join("\n"), /跳过 deepseek/);
    }
    assert.equal(exitCode, null);
  });
});
