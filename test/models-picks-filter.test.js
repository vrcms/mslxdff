// 回归：/v1/models 「勾选即对外目录」——picks 非空只暴露勾选项；空 picks 不过滤；?all=1 逃生门
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterByPicks, modelsHandler } from "../src/routes/models-route.js";

const fakeRes = () => {
  const t = { statusCode: 0, body: null };
  return {
    set statusCode(v) { t.statusCode = v; },
    get statusCode() { return t.statusCode; },
    headersSent: false,
    setHeader() {},
    end(s) { t.body = JSON.parse(s); },
    get body() { return t.body; },
  };
};

const LIST = { object: "list", data: [{ id: "a-free" }, { id: "b-free" }, { id: "c-free" }] };
const fakeModels = { get: async () => LIST };
const req = (url) => ({ url, headers: {} });

describe("/v1/models 勾选即目录", () => {
  it("filterByPicks：picks 非空 → 只留勾选；空 → 原样", () => {
    const f = filterByPicks(LIST, ["b-free"]);
    assert.deepEqual(f.data.map((m) => m.id), ["b-free"]);
    assert.equal(filterByPicks(LIST, []).data.length, 3);
    assert.equal(filterByPicks(LIST, undefined).data.length, 3);
  });

  it("picks 非空：默认只暴露勾选的模型", async () => {
    const res = fakeRes();
    await modelsHandler({ req: req("/v1/models"), res, models: fakeModels, loadPicks: async () => ["b-free"] });
    assert.equal(res.body.data.length, 1);
    assert.equal(res.body.data[0].id, "b-free");
  });

  it("空 picks → 不过滤（全量目录）", async () => {
    const res = fakeRes();
    await modelsHandler({ req: req("/v1/models"), res, models: fakeModels, loadPicks: async () => [] });
    assert.equal(res.body.data.length, 3);
  });

  it("?all=1 → 不过滤（内部取数逃生门）", async () => {
    const res = fakeRes();
    await modelsHandler({ req: req("/v1/models?all=1"), res, models: fakeModels, loadPicks: async () => ["b-free"] });
    assert.equal(res.body.data.length, 3);
  });
});
