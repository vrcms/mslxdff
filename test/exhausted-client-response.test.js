// 失败收尾（exhausted-local / exhausted-all）必须也记 client-response：
// 模型日志对账口径 result == client-response（此前 240 请求 238 result 231 client-response，
// 失败路径 7 条缺口全在这里）。锁 4 个分支：local/all × 有/无 upstream。
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleExhaustedLocal, handleExhaustedAll } from "../src/routes/chat/exhausted-handler.js";

function fakeRes() {
  return {
    statusCode: 0, headersSent: false, _body: null, _ended: false,
    setHeader() {}, end(b) { this._body = b; this._ended = true; },
  };
}

function ctx(over = {}) {
  const events = [];
  return {
    events,
    res: fakeRes(),
    body: { stream: true, model: "m", messages: [{ role: "user", content: "hi" }] },
    lastErr: { model: "m", upstream: null, status: 502, message: "upstream boom" },
    order: ["m"],
    handlerCtx: { reqId: "r1", model: "m" },
    requested: "m",
    useAuto: false,
    evt: (type, data) => events.push({ type, data }),
    logCall: () => {},
    mark: () => {},
    perf0: 0,
    stages: [],
    done: () => {},
    ...over,
  };
}

const relayOk = async () => ({ status: 502, ttfMs: 1, totalMs: 2, aborted: false, interrupted: false, detail: {} });

test("exhausted-local 无 upstream：result 后补 client-response（via=none）", async () => {
  const c = ctx();
  await handleExhaustedLocal(c);
  const cr = c.events.filter((e) => e.type === "client-response");
  assert.equal(cr.length, 1, "必须恰好一条 client-response");
  assert.equal(cr[0].data.status, 502);
  assert.equal(cr[0].data.via, "none");
  assert.equal(c.res.statusCode, 502, "502 json 收尾不变");
});

test("exhausted-local 有 upstream：relay 收尾后补 client-response（via=local）", async () => {
  const c = ctx({ lastErr: { model: "m", upstream: { status: 502 }, status: 502, message: "x" } });
  await handleExhaustedLocal({ ...c, deps: { relay: relayOk } });
  const cr = c.events.filter((e) => e.type === "client-response");
  assert.equal(cr.length, 1);
  assert.equal(cr[0].data.via, "local");
  assert.equal(cr[0].data.status, 502);
});

test("exhausted-all 无 upstream：result 后补 client-response（via=none）", async () => {
  const c = ctx();
  await handleExhaustedAll(c);
  const cr = c.events.filter((e) => e.type === "client-response");
  assert.equal(cr.length, 1);
  assert.equal(cr[0].data.status, 502);
  assert.equal(c.res.statusCode, 502);
});

test("exhausted-all 有 upstream：relay 收尾后补 client-response（via=local）", async () => {
  const c = ctx({ lastErr: { model: "m", upstream: { status: 502 }, status: 502, message: "x" } });
  await handleExhaustedAll({ ...c, deps: { relay: relayOk } });
  const cr = c.events.filter((e) => e.type === "client-response");
  assert.equal(cr.length, 1);
  assert.equal(cr[0].data.via, "local");
});

test("client-response 事件在 result 之后（日志时序与成功路径一致）", async () => {
  const c = ctx();
  await handleExhaustedLocal(c);
  const types = c.events.map((e) => e.type);
  assert.ok(types.indexOf("result") < types.indexOf("client-response"), "result 应先于 client-response");
});
