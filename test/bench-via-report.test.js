import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatViaReport } from "../src/bench/report.js";

describe("bench/via report", () => {
  it("表格含 ★ 最快", () => {
    const results = [
      { provider: "openrouter", model: "google/gemma-3-27b:free", direct: { ok: true, ttfbMs: 820, totalMs: 1100 }, via: { B: { ok: true, ttfbMs: 310, totalMs: 500 }, C: { ok: true, ttfbMs: 540, totalMs: 700 } }, best: "via:B", deltaMs: -510, opencodeSkipped: true },
      { provider: "workbuddy", model: "hy3", direct: { ok: true, ttfbMs: 410, totalMs: 500 }, via: { B: { ok: true, ttfbMs: 380, totalMs: 480 }, C: { ok: false, label: "离线", error: "offline", ttfbMs: null } }, best: "via:B", deltaMs: -30 },
    ];
    const { text } = formatViaReport(results, { peers: [{ id: "B" }, { id: "C" }], meta: { samples: 1, timeout: 30000, includeOpencode: false } });
    assert.match(text, /bench-via/);
    assert.match(text, /★/);
    assert.match(text, /via B/);
    assert.match(text, /offline/);
  });

  it("offline 格显示 — offline", () => {
    const results = [
      { provider: "workbuddy", model: "hy3", direct: { ok: true, ttfbMs: 410, totalMs: 500 }, via: { B: { ok: false, label: "离线", error: "offline" } }, best: "direct", deltaMs: null },
    ];
    const { text } = formatViaReport(results, { peers: [{ id: "B" }] });
    assert.match(text, /offline/);
  });

  it("--json stdout 纯 JSON", () => {
    const results = [
      { provider: "openrouter", model: "m1", direct: { ok: true, ttfbMs: 100, totalMs: 200 }, via: { B: { ok: true, ttfbMs: 80, totalMs: 150 } }, best: "via:B", deltaMs: -20 },
    ];
    const { json, text } = formatViaReport(results, { peers: [{ id: "B" }], json: true, meta: { samples: 1, timeout: 30000 } });
    assert.ok(json);
    assert.equal(json.results.length, 1);
    // text should be JSON string
    const parsed = JSON.parse(text);
    assert.equal(parsed.results[0].best, "via:B");
    assert.equal(parsed.meta.peers[0], "B");
  });
});
