import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

function tmpDir() {
  return mkdtempSync(join(os.tmpdir(), "mslxdff-probe-"));
}

describe("classifyProvider 三态", () => {
  it("workbuddy→local-only / opencode→quota-pool / 其他→latency-compare", async () => {
    const { classifyProvider } = await import("../src/providers/classify.js");
    assert.equal(classifyProvider("workbuddy"), "local-only");
    assert.equal(classifyProvider("WorkBuddy"), "local-only");
    assert.equal(classifyProvider("opencode"), "quota-pool");
    assert.equal(classifyProvider("openrouter"), "latency-compare");
    assert.equal(classifyProvider("clinebot"), "latency-compare");
    assert.equal(classifyProvider("bai"), "latency-compare");
    assert.equal(classifyProvider(""), "latency-compare");
  });
});

describe("emaMerge 纯函数", () => {
  it("首次取原值，之后 0.7/0.3 递推", async () => {
    const { emaMerge } = await import("../src/providers/classify.js");
    assert.equal(emaMerge(null, 100), 100);
    assert.equal(emaMerge(100, 200), 130);
    assert.equal(emaMerge(130, 200), 151);
  });
  it("非法样本不参与", async () => {
    const { emaMerge } = await import("../src/providers/classify.js");
    assert.equal(emaMerge(100, null), 100);
    assert.equal(emaMerge(null, null), null);
  });
});

describe("probe：direct + relay via", () => {
  it("direct 探针测 TTFB，带可选 key", async () => {
    const { directProbe } = await import("../src/upstream-probe/probe.js");
    let seen = null;
    const fetchImpl = async (url, opts = {}) => {
      seen = { url, headers: opts.headers, method: opts.method };
      return { ok: true, status: 200 };
    };
    const r = await directProbe({ baseUrl: "https://api.x.com", modelsPath: "/models", key: "k1", fetchImpl });
    assert.equal(r.ok, true);
    assert.ok(r.ttfbMs >= 0);
    assert.equal(seen.url, "https://api.x.com/models");
    assert.equal(seen.method, "GET");
    assert.equal(seen.headers.Authorization, "Bearer k1");
  });
  it("direct 失败记 label 不抛", async () => {
    const { directProbe } = await import("../src/upstream-probe/probe.js");
    const fetchImpl = async () => { throw new Error("boom"); };
    const r = await directProbe({ baseUrl: "https://api.x.com", modelsPath: "/models", fetchImpl });
    assert.equal(r.ok, false);
    assert.ok(r.label);
  });
  it("via 探针走组员 /v1/relay 代发 GET", async () => {
    const { relayViaProbe } = await import("../src/upstream-probe/probe.js");
    let seen = null;
    const fetchImpl = async (url, opts = {}) => {
      seen = { url, body: JSON.parse(opts.body) };
      return { ok: true, status: 200, headers: { get: (k) => (k === "x-mslxdff-relay-status" ? "200" : null) } };
    };
    const r = await relayViaProbe({ peerUrl: "http://peer1:8989", peerToken: "pt", targetUrl: "https://api.x.com/models", authHeader: "Bearer k1", fetchImpl });
    assert.equal(r.ok, true);
    assert.ok(r.ttfbMs >= 0);
    assert.equal(seen.url, "http://peer1:8989/v1/relay");
    assert.equal(seen.body.targetUrl, "https://api.x.com/models");
    assert.equal(seen.body.method, "GET");
    assert.equal(seen.body.headers.Authorization, "Bearer k1");
    assert.equal(seen.body.headers.Authorization, "Bearer k1");
    assert.ok(String(seen.body.headers.Authorization));
    assert.equal(seen.body.method, "GET");
  });
  it("via 组员侧上游 4xx → ok:false", async () => {
    const { relayViaProbe } = await import("../src/upstream-probe/probe.js");
    const fetchImpl = async () => ({
      ok: true, status: 200,
      headers: { get: (k) => (k === "x-mslxdff-relay-status" ? "401" : null) },
    });
    const r = await relayViaProbe({ peerUrl: "http://p", peerToken: "", targetUrl: "https://x/models", authHeader: "", fetchImpl });
    assert.equal(r.ok, false);
  });
});

describe("rotateTick：每 tick 一家、EMA 落盘 provider:<id>", () => {
  let dir;
  let file;
  let origEnv;
  beforeEach(() => {
    dir = tmpDir();
    file = join(dir, "via-routes.json");
    origEnv = process.env.MSLXDFF_VIA_ROUTES_FILE;
    process.env.MSLXDFF_VIA_ROUTES_FILE = file;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.MSLXDFF_VIA_ROUTES_FILE;
    else process.env.MSLXDFF_VIA_ROUTES_FILE = origEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  function mkDeps({ directOk = true, viaOk = true, directDelayMs = 0, peers = [{ url: "http://p1:8989", token: "t1" }] } = {}) {
    const fetchImpl = async (url) => {
      if (String(url).endsWith("/v1/relay")) {
        if (!viaOk) throw new Error("timeout");
        return { ok: true, status: 200, headers: { get: (k) => (k === "x-mslxdff-relay-status" ? "200" : null) } };
      }
      if (!directOk) throw new Error("direct down");
      if (directDelayMs) await new Promise((r) => setTimeout(r, directDelayMs));
      return { ok: true, status: 200 };
    };
    const events = [];
    return {
      fetchImpl,
      evt: (type, fields) => events.push({ type, fields }),
      peers: { all: () => peers },
      events,
    };
  }

  it("单 tick 探一家并落盘 best + meta.probe", async () => {
    const { probeTargetsFromState, rotateTick } = await import("../src/upstream-probe/rotate.js");
    const deps = mkDeps();
    const stateMod = await import("../src/state.js");
    const cfg = {
      openrouter: { baseUrl: "https://openrouter.ai/api/v1", keys: [], allowedModels: ["google/gemma-3-27b-it:free"], modelsPath: "", chatPath: "" },
      workbuddy: { baseUrl: "https://copilot.tencent.com", keys: ["k"], allowedModels: ["hy3"], modelsPath: "", chatPath: "" },
    };
    const targets = probeTargetsFromState({ loadProviderConfigs: () => cfg, loadProviderKeys: (id) => (id === "workbuddy" ? ["k"] : []), loadProviderBaseUrl: () => "" });
    // workbuddy 是 local-only，不进探针目标
    assert.equal(targets.length, 1);
    assert.equal(targets[0].id, "openrouter");
    // direct 慢 30ms → via 应胜出
    const out = await rotateTick({ targets, cursor: 0, timeoutMs: 1000, directOk: true, viaOk: true, directDelayMs: 30, peers: deps.peers, evt: deps.evt, fetchImpl: (async (url) => {
      if (String(url).endsWith("/v1/relay")) return { ok: true, status: 200, headers: { get: (k) => (k === "x-mslxdff-relay-status" ? "200" : null) } };
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true, status: 200 };
    }) });
    assert.equal(out.probed, "openrouter");
    const data = JSON.parse(readFileSync(file, "utf8"));
    const entry = data.routes["provider:openrouter"];
    assert.ok(entry, "provider key written");
    assert.ok(entry.best.startsWith("via:"), `best=${entry.best}`);
    assert.equal(data.meta.probe, true);
    assert.ok(deps.events.some((e) => e.type === "upstream-probe"));
  });

  it("探针无数据（direct 失败且 via 失败）→ 不写垃圾 best", async () => {
    const { rotateTick } = await import("../src/upstream-probe/rotate.js");
    const deps = mkDeps({ directOk: false, viaOk: false });
    const targets = [{ id: "bai", baseUrl: "https://api.b.ai/v1", modelsPath: "/models", key: "k" }];
    const out = await rotateTick({ targets, cursor: 0, timeoutMs: 1000, ...deps });
    assert.equal(out.probed, "bai");
    const data = JSON.parse(readFileSync(file, "utf8"));
    const entry = data.routes["provider:bai"];
    assert.ok(entry);
    assert.equal(entry.best, "direct");
    assert.equal(entry.direct.ok, false);
    assert.ok(entry.via["p1:8989"].ok === false);
  });

  it("轮转游标推进：cursor 越界回 0", async () => {
    const { nextCursor } = await import("../src/upstream-probe/rotate.js");
    assert.equal(nextCursor(0, 3), 1);
    assert.equal(nextCursor(2, 3), 0);
    assert.equal(nextCursor(0, 0), 0);
  });

  it("空目标/空组 → 静默跳过", async () => {
    const { rotateTick } = await import("../src/upstream-probe/rotate.js");
    const deps = mkDeps({ peers: [] });
    const out = await rotateTick({ targets: [], cursor: 0, timeoutMs: 1000, ...deps });
    assert.equal(out.probed, null);
    assert.equal(existsSync(file), false);
  });

  it("EMA 合并旧值：二次探针取 0.7/0.3", async () => {
    const { rotateTick } = await import("../src/upstream-probe/rotate.js");
    const targets = [{ id: "openrouter", baseUrl: "https://o.ai/v1", modelsPath: "/models", key: "k" }];
    const deps = mkDeps();
    deps.fetchImpl = async (url) => {
      if (String(url).endsWith("/v1/relay")) return { ok: true, status: 200, headers: { get: (k) => (k === "x-mslxdff-relay-status" ? "200" : null) } };
      return { ok: true, status: 200 };
    };
    // 固定计时器：每对调用（t0,t1）的差值为样本 → 第1轮样本 100ms，第2轮样本 200ms
    let calls = 0;
    const samples = [100, 200, 500, 700, 900, 1100]; // 差值 100,200,200,200...
    await rotateTick({ targets, cursor: 0, timeoutMs: 1000, ...deps, sampleMs: () => samples[calls++] ?? 0 });
    await rotateTick({ targets, cursor: 0, timeoutMs: 1000, ...deps, sampleMs: () => samples[calls++] ?? 0 });
    const data = JSON.parse(readFileSync(file, "utf8"));
    const d1 = data.routes["provider:openrouter"].direct;
    assert.ok(d1.totalMs != null || d1.ttfbMs != null);
    // EMA: 100*0.7 + 200*0.3 = 130
    const v = d1.totalMs ?? d1.ttfbMs;
    assert.equal(v, 130);
  });
});

describe("getViaRoute provider 级回退 + TTL 默认 5min", () => {
  let dir;
  let origEnv;
  beforeEach(() => {
    dir = tmpDir();
    origEnv = process.env.MSLXDFF_VIA_ROUTES_FILE;
    process.env.MSLXDFF_VIA_ROUTES_FILE = join(dir, "via-routes.json");
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.MSLXDFF_VIA_ROUTES_FILE;
    else process.env.MSLXDFF_VIA_ROUTES_FILE = origEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it("精确模型键优先，无精确键回退 provider:<id>", async () => {
    const { saveViaRoutes, getViaRoute } = await import("../src/bench/via-routes.js");
    saveViaRoutes([
      { model: "provider:openrouter", best: "via:p1:8989", via: { "p1:8989": { ok: true, ttfbMs: 100 } }, direct: { ok: true, ttfbMs: 300 }, deltaMs: -200 },
      { model: "openrouter/exact-model", best: "direct", direct: { ok: true, ttfbMs: 10 }, via: {}, deltaMs: null },
    ]);
    assert.equal(getViaRoute("openrouter/exact-model").best, "direct");
    assert.equal(getViaRoute("openrouter/other-model").best, "via:p1:8989");
    assert.equal(getViaRoute("bai/whatever"), null);
  });

  it("TTL 默认 5 分钟：过期 provider 键返 null", async () => {
    const { saveViaRoutes, getViaRoute } = await import("../src/bench/via-routes.js");
    saveViaRoutes([{ model: "provider:openrouter", best: "via:p1", via: {}, direct: { ok: true } }]);
    // 手工把 at 改旧
    const { readFileSync: rf, writeFileSync: wf } = await import("node:fs");
    const f = process.env.MSLXDFF_VIA_ROUTES_FILE;
    const j = JSON.parse(rf(f, "utf8"));
    j.routes["provider:openrouter"].at = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    wf(f, JSON.stringify(j));
    assert.equal(getViaRoute("openrouter/x"), null);
    // TTL=0 显式关闭则仍命中
    assert.equal(getViaRoute("openrouter/x", { ttlMs: 0 }).best, "via:p1");
  });
});

describe("display 渲染", () => {
  it("group list 行缀：有数据显示 best，无数据 null", async () => {
    const { groupRowSuffix } = await import("../src/upstream-probe/display.js");
    const routes = { "provider:openrouter": { best: "via:p1:8989", deltaMs: -120, direct: { ok: true, ttfbMs: 300 } } };
    const hit = groupRowSuffix("http://p1:8989", routes);
    assert.ok(hit.includes("via-routes"));
    assert.ok(hit.includes("openrouter"));
    assert.equal(groupRowSuffix("http://other:1", routes), null);
    assert.equal(groupRowSuffix("http://p1:8989", {}), null);
  });
  it("status 汇总：空数据给引导文案", async () => {
    const { statusViaSummary } = await import("../src/upstream-probe/display.js");
    const none = statusViaSummary({ routes: {}, meta: {} });
    assert.ok(String(none).length > 0, "空态也要有文案");
    const some = statusViaSummary({ routes: { "provider:openrouter": { best: "direct", direct: { ok: true, ttfbMs: 88 } } }, meta: { at: new Date().toISOString() } });
    assert.ok(some.includes("openrouter") || some.includes("direct"));
  });
});
