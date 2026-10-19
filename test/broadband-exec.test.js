import { test } from "node:test";
import assert from "node:assert/strict";
import { createBroadbandExec } from "../src/runtime/broadband.js";

// 造一个假 upstream.chat：按需返回 Response 或抛错。
function fakeUpstream({ res, err }) {
  return { chat: async () => { if (err) throw err; return res; } };
}
function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
// 捕获回传给组长的 result
function captureFetch(sink) {
  return async (url, opts) => {
    sink.push({ url, body: JSON.parse(opts.body) });
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

test("01 上游正常 200：回传 status 200，不写 errors.log", async () => {
  const posted = [];
  const errors = [];
  const exec = createBroadbandExec({
    token: "t",
    upstream: fakeUpstream({ res: jsonResponse(200, { choices: [{ message: { content: "hi" } }] }) }),
    logs: { appendError: (e) => errors.push(e) },
    log: () => {},
    fetchImpl: captureFetch(posted),
  });
  await exec({ name: "wg", leaderUrl: "http://leader" }, "r1", { model: "m", stream: false, messages: [] });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body.result.status, 200);
  assert.equal(errors.length, 0);
});

test("02 成员打上游**抛错**：result.status=502，errors.log 记到 cause 链（这是核心修复）", async () => {
  const posted = [];
  const errors = [];
  const netErr = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:443"), { code: "ECONNREFUSED", address: "10.0.0.9" }),
  });
  const logs = [];
  const exec = createBroadbandExec({
    token: "t",
    upstream: fakeUpstream({ err: netErr }),
    logs: { appendError: (e) => errors.push(e) },
    log: (m) => logs.push(m),
    fetchImpl: captureFetch(posted),
  });
  await exec({ name: "wg", leaderUrl: "http://leader" }, "r2", { model: "deepseek-x", stream: false, messages: [] });
  assert.equal(posted[0].body.result.status, 502);
  const bodyErr = JSON.parse(posted[0].body.result.body).error;
  assert.match(bodyErr, /ECONNREFUSED/, "回包带上真实原因，不再是光秃秃 fetch failed");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /ECONNREFUSED/);
  assert.match(errors[0].message, /peer=10\.0\.0\.9/);
  assert.equal(errors[0].reqId, "r2");
  assert.equal(errors[0].model, "deepseek-x");
});

test("03 上游返回 HTTP 429：记 errors.log（成员侧可见上游回错）", async () => {
  const posted = [];
  const errors = [];
  const exec = createBroadbandExec({
    token: "t",
    upstream: fakeUpstream({ res: jsonResponse(429, { error: "rate limited" }) }),
    logs: { appendError: (e) => errors.push(e) },
    log: () => {},
    fetchImpl: captureFetch(posted),
  });
  await exec({ name: "wg", leaderUrl: "http://leader" }, "r3", { model: "m", stream: false, messages: [] });
  assert.equal(posted[0].body.result.status, 429);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].status, 429);
  assert.match(errors[0].message, /HTTP 429/);
});

test("04 回传组长失败：记 errors.log，不静默吞", async () => {
  const errors = [];
  const failing = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED" } }); };
  const exec = createBroadbandExec({
    token: "t",
    upstream: fakeUpstream({ res: jsonResponse(200, { ok: true }) }),
    logs: { appendError: (e) => errors.push(e) },
    log: () => {},
    fetchImpl: failing,
  });
  await exec({ name: "wg", leaderUrl: "http://leader" }, "r4", { model: "m", stream: false, messages: [] });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /回传组长/);
});

test("05 无 logs 注入也不炸（纯函数容错）", async () => {
  let exec;
  assert.doesNotThrow(() => {
    exec = createBroadbandExec({ token: "t", upstream: fakeUpstream({ err: new Error("x") }), log: () => {}, fetchImpl: captureFetch([]) });
  });
  await assert.doesNotReject(() => exec({ name: "wg", leaderUrl: "http://leader" }, "r5", { model: "m", stream: false, messages: [] }));
});
