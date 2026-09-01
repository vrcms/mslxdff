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
});
