// v6pool 离线测试（二）：claim / rotate —— 零网络、零真实 ip 命令、零真实等待。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLAIM_FILE, createClaimer, isAlreadyGone, isAlreadyThere } from "../src/v6pool/claim.js";
import { RETAIN_MAX, createV6Dispatcher } from "../src/v6pool/rotate.js";

const tmp = () => mkdtempSync(join(tmpdir(), "v6pool-egress-"));
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** 假 Agent：把被 tapHandler 包过的 handler 交回测试，由测试驱动 onHeaders/onData。 */
function captureAgent(name = "agent") {
  const box = { name };
  return {
    box,
    dispatch(opts, handler) {
      box.opts = opts;
      box.handler = handler;
      return true;
    },
    async close() {
      box.closed = (box.closed || 0) + 1;
    },
  };
}
const handlerStub = () => ({ onHeaders() {}, onData() {}, onComplete() {}, onError() {} });

function fakeExec(script = {}) {
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, ...args].join(" "));
    if (script[args.join(" ")]) throw script[args.join(" ")];
    return { stdout: "", stderr: "" };
  };
  exec.calls = calls;
  return exec;
}

// ---------- claim：认领账 ----------

test("claim：add 模式认领/释放都落账，命令形状固定", async () => {
  const dir = tmp();
  const exec = fakeExec();
  const c = createClaimer({ iface: "eth0", mode: "add", dir, log: () => {}, exec });
  await c.ensure("2403:71c0:2000:114a::b1");
  assert.deepEqual(exec.calls, ["ip -6 addr add 2403:71c0:2000:114a::b1/128 dev eth0 nodad"]);
  const rec = JSON.parse(readFileSync(join(dir, CLAIM_FILE), "utf8"));
  assert.deepEqual(rec.addrs, ["2403:71c0:2000:114a::b1"]);
  assert.equal(rec.iface, "eth0");
  assert.equal(rec.mode, "add");
  await c.release("2403:71c0:2000:114a::b1");
  assert.equal(exec.calls[1], "ip -6 addr del 2403:71c0:2000:114a::b1/128 dev eth0");
  assert.deepEqual(c.claimed(), []);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, CLAIM_FILE), "utf8")).addrs, []);
});

test("claim：bind 模式完全不碰网卡（零副作用是首选路径）", async () => {
  const exec = fakeExec();
  const c = createClaimer({ iface: "eth0", mode: "bind", dir: tmp(), log: () => {}, exec });
  await c.ensure("2403::b1");
  assert.deepEqual(exec.calls, [], "bind 模式不许跑任何 ip 命令");
  assert.equal(await c.release("2403::b1"), false);
  assert.deepEqual(await c.sweepStale(), { removed: [], failed: [] });
});

test("claim：幂等（File exists 不算失败）与「已经不在」（删不到不算失败）", async () => {
  assert.equal(isAlreadyThere({ stderr: "RTNETLINK answers: File exists" }), true);
  assert.equal(isAlreadyThere({ stderr: "Operation not permitted" }), false);
  assert.equal(isAlreadyGone({ stderr: "Cannot assign requested address" }), true);
  assert.equal(isAlreadyGone({ stderr: "Operation not permitted" }), false);

  const dir = tmp();
  const exec = fakeExec({ "addr add 2403::c1/128 dev eth0 nodad": { stderr: "RTNETLINK answers: File exists" } });
  const c = createClaimer({ iface: "eth0", mode: "add", dir, log: () => {}, exec });
  await c.ensure("2403::c1");
  assert.deepEqual(c.claimed(), ["2403::c1"], "已在网卡上也要记进账（否则收摊时漏放）");
});

test("claim：sweepStale 只删账上的地址，不扫全表不猜", async () => {
  const dir = tmp();
  const c1 = createClaimer({ iface: "eth0", mode: "add", dir, log: () => {}, exec: fakeExec() });
  await c1.ensure("2403::d1");
  await c1.ensure("2403::d2");
  const exec2 = fakeExec();
  const c2 = createClaimer({ iface: "eth0", mode: "add", dir, log: () => {}, exec: exec2 });
  const r = await c2.sweepStale();
  assert.deepEqual(r.removed, ["2403::d1", "2403::d2"]);
  assert.deepEqual(exec2.calls, ["ip -6 addr del 2403::d1/128 dev eth0", "ip -6 addr del 2403::d2/128 dev eth0"]);
  assert.deepEqual(c2.claimed(), []);
});

test("claim：退出钩子的同步释放也走同一份账（清空后不再重复删）", async () => {
  const dir = tmp();
  const c = createClaimer({ iface: "eth0", mode: "add", dir, log: () => {}, exec: fakeExec() });
  await c.ensure("2403::e1");
  const calls = [];
  const done = c.releaseAllSync({ execSync: (f, a) => calls.push([f, ...a].join(" ")) });
  assert.deepEqual(done, ["2403::e1"]);
  assert.deepEqual(calls, ["ip -6 addr del 2403::e1/128 dev eth0"]);
  assert.deepEqual(c.releaseAllSync({ execSync: () => {} }), [], "账已清空 ⇒ 不再重复删");
});

// ---------- rotate：槽位 dispatcher ----------

test("rotate：session 策略下同会话粘同一源地址，不同会话分流", () => {
  const order = [];
  const agentFactory = (a) => ({
    dispatch: () => {
      order.push(a);
      return true;
    },
    close: async () => {},
  });
  const d = createV6Dispatcher({ addrs: ["A1", "A2"], agentFactory, fallbackAgent: null, log: () => {} });
  d.dispatch({ headers: ["x-opencode-session", "s1"] }, handlerStub());
  d.dispatch({ headers: ["x-opencode-session", "s1"] }, handlerStub());
  d.dispatch({ headers: ["x-opencode-session", "s2"] }, handlerStub());
  assert.deepEqual(order, ["A1", "A1", "A2"], "同会话粘同一出口；不同会话分流（上游按 session 做粘性路由）");
});

test("rotate：每次响应都记账；首个 200 出取证行（没换过址就不许说「换址后恢复」）", async () => {
  const lines = [];
  const made = [];
  const d = createV6Dispatcher({
    addrs: ["A1"],
    agentFactory: (a) => { const x = captureAgent(a); made.push(x); return x; },
    fallbackAgent: null,
    log: (l) => lines.push(l),
  });
  d.dispatch({ headers: [] }, handlerStub());
  made[0].box.handler.onHeaders(200, {}, null, "OK");
  await tick(5);
  assert.equal(d.stats().slots[0].counts[200], 1);
  assert.ok(lines.some((l) => l.includes("首个响应 200") && !l.includes("换址后")));
});

test("rotate：429 FreeUsageLimitError ⇒ 换该槽源地址，旧地址先退休不抽在飞请求", async () => {
  const lines = [];
  const made = [];
  const releases = [];
  const picks = ["NEW1", "NEW2"];
  let i = 0;
  const d = createV6Dispatcher({
    addrs: ["OLD1"],
    agentFactory: (a) => { const x = captureAgent(a); made.push(x); return x; },
    fallbackAgent: null,
    log: (l) => lines.push(l),
    claimer: { ensure: async (a) => a, release: async (a) => { releases.push(a); return true; } },
    pickAddress: () => picks[Math.min(i++, picks.length - 1)],
    retireMs: 0,
  });
  d.dispatch({ headers: [] }, handlerStub());
  made[0].box.handler.onHeaders(429, {}, null, "Too Many Requests");
  made[0].box.handler.onData(Buffer.from('{"error":{"type":"FreeUsageLimitError","message":"usage limit"}}'));
  await tick();
  assert.equal(d.entries()[0].addr, "NEW1", "必须换到新源地址");
  assert.equal(d.stats().slots[0].swaps, 1);
  const swapLine = lines.find((l) => l.includes("换源地址"));
  for (const needle of ["OLD1", "NEW1", "free-quota", "第 1 次", "强制跳过冷却"]) {
    assert.ok(swapLine.includes(needle), `换址行缺 ${needle}：${swapLine}`);
  }
  assert.deepEqual(releases, [], "旧地址先留着（保护在飞请求），收摊才释放");
  await d.close();
  assert.deepEqual(releases, ["OLD1"], "收摊时必须释放");
});

test("rotate：账号日配额 BlackUsageLimitError 绝不换地址；无 FreeTier 判决的 403 也不换", async () => {
  const lines = [];
  const made = [];
  const d = createV6Dispatcher({
    addrs: ["A1"],
    agentFactory: (a) => { const x = captureAgent(a); made.push(x); return x; },
    fallbackAgent: null,
    log: (l) => lines.push(l),
    pickAddress: () => "NEVER",
    retireMs: 0,
  });
  d.dispatch({ headers: [] }, handlerStub());
  made[0].box.handler.onHeaders(429, {}, null, "");
  made[0].box.handler.onData(Buffer.from('{"error":{"type":"BlackUsageLimitError"}}'));
  await tick();
  assert.equal(d.entries()[0].addr, "A1", "账号日配额换出口抬不动，必须不换");
  assert.ok(lines.some((l) => l.includes("black-quota")));
  made[0].box.handler.onHeaders(403, {}, null, "Forbidden");
  made[0].box.handler.onData(Buffer.from('{"error":{"type":"SomethingElse"}}'));
  await tick();
  assert.equal(d.entries()[0].addr, "A1", "与出口限额无关的 403 必须不换");
});

test(`rotate：退休账有硬上限（RETAIN_MAX=${RETAIN_MAX}）——超出才关 Agent 再释放`, async () => {
  const releases = [];
  const closed = [];
  const seq = [];
  for (let k = 0; k < 40; k++) seq.push(`S${k}`);
  let i = 0;
  const d = createV6Dispatcher({
    addrs: ["S0"],
    agentFactory: (a) => ({ addr: a, dispatch: () => true, close: async () => { closed.push(a); } }),
    fallbackAgent: null,
    log: () => {},
    claimer: { ensure: async (a) => a, release: async (a) => { releases.push(a); return true; } },
    pickAddress: () => seq[i++],
    retireMs: 0,
  });
  for (let k = 0; k < RETAIN_MAX + 1; k++) await d.swap(0, { status: 429, kind: "free-quota", forced: true });
  assert.equal(releases.length, 1, `${RETAIN_MAX + 1} 次换址只应释放 1 个（保留上限）`);
  assert.deepEqual(releases, ["S0"]);
  assert.deepEqual(closed, ["S0"]);
  assert.equal(d.stats().history.length, 1);
  await d.close();
  await d.close();
  assert.equal(d.size, 0, "close 必须幂等");
});

test("rotate：空池无兜底直接抛（宁可炸也不静默黑洞）；有兜底则走兜底", () => {
  const d = createV6Dispatcher({ addrs: [], fallbackAgent: null, log: () => {} });
  assert.throws(() => d.dispatch({}, handlerStub()), /无直连兜底/);
  const fb = captureAgent("fallback");
  const d2 = createV6Dispatcher({ addrs: [], fallbackAgent: fb, log: () => {} });
  d2.dispatch({}, handlerStub());
  assert.ok(fb.box.opts, "空池必须走直连兜底");
});

test("rotate：全部槽在换址中时走直连兜底，且只报一次（不刷屏）", async () => {
  const lines = [];
  const fb = captureAgent("fallback");
  const made = [];
  let release = null;
  const d = createV6Dispatcher({
    addrs: ["A1"],
    agentFactory: (a) => { const x = captureAgent(a); made.push(x); return x; },
    fallbackAgent: fb,
    log: (l) => lines.push(l),
    claimer: {
      ensure: async (a) => {
        await new Promise((r) => { release = r; });
        return a;
      },
      release: async () => true,
    },
    pickAddress: () => "A2",
  });
  const p = d.swap(0, { status: 429, kind: "free-quota", forced: true });
  await tick(5);
  d.dispatch({}, handlerStub());
  d.dispatch({}, handlerStub());
  assert.ok(fb.box.opts, "换址中的槽不许接请求（会挂到超时），应走直连");
  assert.equal(lines.filter((l) => l.includes("走直连")).length, 1, "同一次状态只报一行");
  release();
  await p;
  assert.equal(d.entries()[0].addr, "A2");
});
