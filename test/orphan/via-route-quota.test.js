import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

// ADR-0015 票02：quota-pool（opencode）不走 via-route 单路径——直连先行，429 后靠既有 peer 兜底。
// latency-compare 照常读表（含 provider:<id> 级回退）。

function tmpDir() {
  return mkdtempSync(join(os.tmpdir(), "mslxdff-via-quota-"));
}

describe("via-route quota-pool 门", () => {
  let dir;
  let origEnv;
  let origState;
  beforeEach(() => {
    dir = tmpDir();
    origEnv = process.env.MSLXDFF_VIA_ROUTES_FILE;
    origState = process.env.MSLXDFF_STATE_FILE;
    process.env.MSLXDFF_VIA_ROUTES_FILE = join(dir, "via-routes.json");
    // 用隔离 state 让 shouldUseGroup 默认 on（寄生在 use-group  gate 上）
    const sf = join(dir, "state.json");
    process.env.MSLXDFF_STATE_FILE = sf;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.MSLXDFF_VIA_ROUTES_FILE;
    else process.env.MSLXDFF_VIA_ROUTES_FILE = origEnv;
    if (origState === undefined) delete process.env.MSLXDFF_STATE_FILE;
    else process.env.MSLXDFF_STATE_FILE = origState;
    rmSync(dir, { recursive: true, force: true });
  });

  it("opencode 显式请求：即使静态表有 via 也跳过（handled:false）", async () => {
    const { saveViaRoutes } = await import("../src/bench/via-routes.js");
    saveViaRoutes([{ model: "opencode/big-pickle", best: "via:p1:8989", via: {}, direct: { ok: true, ttfbMs: 100 } }]);
    const { handleViaRoute } = await import("../src/routes/chat/via-route-handler.js");
    const evts = [];
    const out = await handleViaRoute({
      model: "opencode/big-pickle",
      body: { model: "opencode/big-pickle", messages: [], stream: false },
      peers: { ordered: () => [], orderedByLastError: () => [] },
      handlerCtx: { reqId: "q1", hops: 0 },
      evt: (t, f) => evts.push({ t, f }),
      logCall: () => {}, logError: () => {}, mark: () => {},
      perf0: 0, stages: [], startedAt: 0, plugins: [],
      res: null, requested: "opencode/big-pickle",
      useAuto: false, lockModel: "", auto: null,
    });
    assert.equal(out.handled, false);
    assert.ok(evts.some((e) => e.t === "via-route-skip"), "应有 via-route-skip 对账事件");
  });

  it("latency-compare：探针表 provider 级 best 仍命中 via 单路径", async () => {
    const { saveViaRoutes } = await import("../src/bench/via-routes.js");
    saveViaRoutes([{ model: "provider:openrouter", best: "via:p1:8989", via: { "p1:8989": { ok: true, ttfbMs: 100 } }, direct: { ok: true, ttfbMs: 300 }, deltaMs: -200 }]);
    const { getViaRoute } = await import("../src/bench/via-routes.js");
    const route = getViaRoute("openrouter/google/gemma-3-27b-it:free");
    assert.ok(route, "provider 级回退应命中");
    assert.equal(route.best, "via:p1:8989");
  });

  it("useGroup=off 仍优先：所有供应商 handled:false 路径不变", async () => {
    process.env.MSLXDFF_USE_GROUP = "0";
    try {
      const { shouldUseGroupForModel } = await import("../src/state/schemas/use-group.js");
      assert.equal(shouldUseGroupForModel("openrouter/x"), false);
      assert.equal(shouldUseGroupForModel("workbuddy/hy3"), false);
    } finally {
      delete process.env.MSLXDFF_USE_GROUP;
    }
  });
});
