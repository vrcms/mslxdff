// 回归：`-models` 候选并入网关 live 模型（allowAny 空白名单供应商的模型只存在于 /v1/models）
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchDaemonModelIds } from "../src/cli/commands/model/live-models.js";

const jsonRes = (obj, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => obj,
});

describe("model live-models", () => {
  it("200 → 返回 id 列表", async () => {
    const ids = await fetchDaemonModelIds({
      port: 8989, host: "127.0.0.1", token: "t1",
      fetchImpl: async (url, init) => {
        assert.equal(url, "http://127.0.0.1:8989/v1/models?all=1");
        assert.equal(init.headers.Authorization, "Bearer t1");
        return jsonRes({ data: [{ id: "qoder/qfmodel" }, { id: "big-pickle" }, { nope: 1 }] });
      },
    });
    assert.deepEqual(ids, ["qoder/qfmodel", "big-pickle"]);
  });

  it("401/网络异常 → 静默空数组（不抛，候选退回 allowlist+picks）", async () => {
    const unauthorized = await fetchDaemonModelIds({ port: 1, host: "127.0.0.1", token: "x", fetchImpl: async () => jsonRes({}, 401) });
    assert.deepEqual(unauthorized, []);
    const boom = await fetchDaemonModelIds({ port: 1, host: "127.0.0.1", token: "x", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
    assert.deepEqual(boom, []);
  });
});
