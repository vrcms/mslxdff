// -setto claude-desktop 的 1M 证据 Adapter 单测：一次 GET 本机 /v1/models，失败一律降级不抛（spec《证据获取失败不阻塞写盘》）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { oneMContexts } from "../src/claude-desktop/context1m.js";

function fakeFetch(body, { ok = true, status = 200 } = {}) {
  const fn = async (url, init = {}) => {
    fn.lastUrl = url;
    fn.lastInit = init;
    if (!ok) return { ok: false, status };
    return { ok: true, status, json: async () => body };
  };
  return fn;
}

test("oneMContexts: data[] 收齐 id→context_length（键小写）；顶层缺/非正才回落 capabilities.context", async () => {
  const f = fakeFetch({
    data: [
      { id: "Big-1M", context_length: 1_000_000 },
      { id: "wb/x", capabilities: { context: 200_000 } },
      { id: "bad-ctx", context_length: 0, capabilities: { context: 500 } },
      { id: "no-ctx", context_length: null, capabilities: {} },
      { id: "" },
    ],
  });
  const r = await oneMContexts({ port: 8989, token: "tk", fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(r.contexts.get("big-1m"), 1_000_000);
  assert.equal(r.contexts.get("wb/x"), 200_000);
  assert.equal(r.contexts.get("bad-ctx"), 500);
  assert.equal(r.contexts.has("no-ctx"), false);
  assert.equal(f.lastUrl, "http://127.0.0.1:8989/v1/models");
  assert.equal(f.lastInit.headers.Authorization, "Bearer tk");
});

test("oneMContexts: 拒连 / 非 200 / 形状坏一律 {ok:false,reason}，不抛", async () => {
  const refused = await oneMContexts({ port: 1, token: "t", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /ECONNREFUSED/);
  const http401 = await oneMContexts({ port: 8989, token: "t", fetchImpl: fakeFetch({}, { ok: false, status: 401 }) });
  assert.equal(http401.ok, false);
  assert.match(http401.reason, /401/);
  const broken = await oneMContexts({ port: 8989, token: "t", fetchImpl: fakeFetch({}) });
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /data\[\]/);
});
