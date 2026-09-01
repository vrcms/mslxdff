import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { orchestrateVia } from "../src/bench/via.js";

describe("bench/via orchestrator", () => {
  it("默认跳过 opencode", async () => {
    const models = [{ provider: "opencode", model: "opencode/big-pickle", id: "opencode/big-pickle" }, { provider: "openrouter", model: "google/gemma-3-27b:free", id: "google/gemma-3-27b:free" }];
    let viaCalls = 0;
    const viaProbeFn = async () => { viaCalls++; return { ok: true, ttfbMs: 100, totalMs: 200 }; };
    const directRunner = async () => ({ ok: true, ttfbMs: 500, totalMs: 600 });
    const peers = [{ id: "B", url: "http://1.1.1.1:8989" }];
    const results = await orchestrateVia({ models, peers, directRunner, viaProbeFn, includeOpencode: false, token: "tok" });
    assert.equal(results.length, 1);
    assert.equal(results[0].provider, "openrouter");
    assert.equal(viaCalls, 1);
    assert.equal(results[0].opencodeSkipped, true);
  });

  it("同 model 串行 direct -> via B -> via C", async () => {
    const models = [{ provider: "openrouter", model: "m1", id: "m1" }];
    const peers = [{ id: "B", url: "http://b:8989" }, { id: "C", url: "http://c:8989" }];
    const order = [];
    const directRunner = async () => { order.push("direct"); return { ok: true, ttfbMs: 800, totalMs: 900 }; };
    const viaProbeFn = async ({ peerUrl }) => {
      order.push(peerUrl.includes("b:") ? "viaB" : "viaC");
      // tiny delay to ensure serial
      return { ok: true, ttfbMs: peerUrl.includes("b:") ? 300 : 400, totalMs: 500 };
    };
    const results = await orchestrateVia({ models, peers, directRunner, viaProbeFn, token: "tok" });
    assert.deepEqual(order, ["direct", "viaB", "viaC"]);
    assert.equal(results[0].best, "via:B");
    assert.equal(results[0].deltaMs, -500);
  });

  it("某 via offline 不阻塞其他", async () => {
    const models = [{ provider: "workbuddy", model: "hy3", id: "hy3" }];
    const peers = [{ id: "B", url: "http://b:8989" }, { id: "C", url: "http://c:8989" }];
    const directRunner = async () => ({ ok: true, ttfbMs: 410, totalMs: 500 });
    const viaProbeFn = async ({ peerUrl }) => {
      if (peerUrl.includes("c:")) return { ok: false, label: "离线", error: "offline", ttfbMs: null, totalMs: 0 };
      return { ok: true, ttfbMs: 380, totalMs: 480 };
    };
    const results = await orchestrateVia({ models, peers, directRunner, viaProbeFn, token: "tok" });
    assert.equal(results[0].via.B.ok, true);
    assert.equal(results[0].via.C.ok, false);
    assert.equal(results[0].best, "via:B");
  });

  it("includeOpencode=true 时不过滤", async () => {
    const models = [{ provider: "opencode", model: "big-pickle", id: "big-pickle" }];
    const peers = [{ id: "B", url: "http://b:8989" }];
    const directRunner = async () => ({ ok: true, ttfbMs: 100, totalMs: 150 });
    const viaProbeFn = async () => ({ ok: true, ttfbMs: 80, totalMs: 120 });
    const results = await orchestrateVia({ models, peers, directRunner, viaProbeFn, includeOpencode: true, token: "tok" });
    assert.equal(results.length, 1);
    assert.equal(results[0].opencodeSkipped, false);
  });
});
