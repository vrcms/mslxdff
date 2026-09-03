import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { probeModels } from "../src/bench/probe.js";

function mockFetch(map) {
  return async (url) => {
    const v = map[url];
    if (v instanceof Error) throw v;
    if (!v) return { ok: false, status: 404, headers: { get: () => "" }, text: async () => "{}", json: async () => ({}) };
    if (!v.headers) v.headers = { get: () => "application/json" };
    if (!v.text && v.json) {
      const j = v.json;
      v.text = async () => JSON.stringify(await j());
    }
    return v;
  };
}

describe("bench/probe", () => {
  it("成功命中 /v1/models", async () => {
    const fetchImpl = mockFetch({
      "https://api.example.com/v1/models": { ok: true, status: 200, json: async () => ({ data: [{ id: "a" }, { id: "b" }] }) },
    });
    const r = await probeModels({ baseUrl: "https://api.example.com", fetchImpl });
    assert.equal(r.ok, true);
    assert.equal(r.data.length, 2);
    assert.equal(r.data[0].id, "a");
  });

  it("回退到 /models", async () => {
    const fetchImpl = mockFetch({
      "https://api.example.com/v1/models": { ok: false, status: 404, json: async () => ({}) },
      "https://api.example.com/models": { ok: true, status: 200, json: async () => ({ models: [{ id: "x" }] }) },
    });
    const r = await probeModels({ baseUrl: "https://api.example.com", fetchImpl });
    assert.equal(r.ok, true);
    assert.equal(r.data[0].id, "x");
    assert.equal(r.tried.length, 2);
  });

  it("兼容裸数组返回", async () => {
    const fetchImpl = mockFetch({
      "https://api.example.com/v1/models": { ok: true, status: 200, json: async () => ([{ id: "k1" }, { id: "k2" }]) },
    });
    const r = await probeModels({ baseUrl: "https://api.example.com", fetchImpl });
    assert.equal(r.ok, true);
    assert.equal(r.data.length, 2);
  });

  it("全部失败返回 ok=false", async () => {
    const fetchImpl = mockFetch({});
    const r = await probeModels({ baseUrl: "https://api.example.com", fetchImpl });
    assert.equal(r.ok, false);
    assert.ok(r.tried.length >= 2);
  });

  it("missing baseUrl 直接失败", async () => {
    const r = await probeModels({ baseUrl: "", fetchImpl: async () => ({ ok: true }) });
    assert.equal(r.ok, false);
  });
});
