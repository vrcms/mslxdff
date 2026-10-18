// G1a（ADR-0061）：opencode free 模型撞出口池级 429 ⇒ **请求内**换 v6 源地址重发，把本节点的
// 出口池在这一发里榨干，而不是把 429 退回客户端/组长。离线、零网络：dispatcher 与 fetch 全注入。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createV6Dispatcher } from "../src/v6pool/rotate.js";
import { createUpstreamClient } from "../src/upstream.js";
import { createUpstreamEngine } from "../src/upstream-engine/index.js";

const BODY429 = '{"error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."}}';
const ok = () => new Response('{"choices":[{"message":{"content":"hi"}}]}', { status: 200, headers: { "content-type": "application/json" } });
const limited = () => new Response(BODY429, { status: 429, headers: { "content-type": "application/json" } });

// ---------- rotateFor：v6 dispatcher 的请求内换出口 ----------

test("rotateFor：空池/全槽换址中 ⇒ null（调用方正常收场，绝不黑洞）", async () => {
  const empty = createV6Dispatcher({ addrs: [], fallbackAgent: null, log: () => {} });
  assert.equal(await empty.rotateFor("s1"), null);

  // 单槽且被并发换址占住：availableIndexes 为空 ⇒ null，不许硬派
  let holdRelease = null;
  const d = createV6Dispatcher({
    addrs: ["A1"], fallbackAgent: null, log: () => {},
    agentFactory: () => ({ dispatch: () => true, close: async () => {} }),
    claimer: { ensure: async (a) => { await new Promise((r) => { holdRelease = r; }); return a; }, release: async () => true },
    pickAddress: () => "A2",
  });
  const inflight = d.swap(0, { status: 429, kind: "free-quota", forced: true });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await d.rotateFor("s1"), null, "槽正在换址时不许二次换");
  holdRelease();
  await inflight;
});

test("rotateFor：换的是 session 粘的那个槽，原地换 addr（粘性映射不失效），返回新 Agent", async () => {
  const made = [];
  const picks = ["NEW1", "NEW2"];
  let i = 0;
  const d = createV6Dispatcher({
    addrs: ["OLD1", "OLD2"],
    agentFactory: (a) => { const x = { addr: a, dispatch: () => true, close: async () => {} }; made.push(x); return x; },
    fallbackAgent: null, log: () => {},
    claimer: { ensure: async (a) => a, release: async () => true },
    pickAddress: () => picks[Math.min(i++, picks.length - 1)],
    retireMs: 0,
  });
  const first = await d.rotateFor("sess-a");
  assert.ok(first && first.agent, "必须返回换址后的出口");
  assert.notEqual(first.addr, "OLD1", "地址必须真的换了");
  assert.equal(first.from, "OLD1", "取证要报出旧地址");
  // 粘性安全：selector 仍把同一会话指到同一**槽位**（index 不变），槽上的新地址跟着走
  const second = await d.rotateFor("sess-a");
  assert.equal(second.agent, d.entries() && made[made.length - 1], "会话继续粘同一槽（index 0），换的是它的新地址");
  assert.notEqual(second.addr, first.addr, "同一槽第二次换址换到下一个地址");
});

// ---------- upstream.chat：请求内换出口重试环 ----------

/** 假 v6 dispatcher：`rotateFor` 挂在 extDispatcher 对象上（与真 createV6Dispatcher 同形状）；
 *  fetchImpl 按 opts.dispatcher 认出口。retry 关掉 transport 内建 429 重试，只看我这一环。 */
function fakePool({ exhaustFirst = 1, all429 = false } = {}) {
  const agents = [];
  let rotations = 0;
  // all429=池子无限深但全耗尽（测"次数上限"该在哪停）；否则只有前 exhaustFirst 个出口可换。
  let quotaLeft = all429 ? Infinity : exhaustFirst;
  const mk = (name) => { const a = { name, dispatch: () => true, close: async () => {} }; agents.push(a); return a; };
  const extDispatcher = mk("egress-0"); // 初始出口；rotateFor 挂它身上
  extDispatcher.rotateFor = async () => {
    if (quotaLeft <= 0) return null; // 池榨干：没有更多出口
    quotaLeft -= 1;
    const next = mk(`egress-${++rotations}`);
    return { agent: next, addr: next.name, from: `egress-${rotations - 1}` };
  };
  return {
    extDispatcher,
    fetchImpl: async (url, opts) => {
      const name = opts?.dispatcher?.name ?? "none";
      return all429 || (name === "egress-0" && exhaustFirst > 0) ? limited() : ok();
    },
    calls: () => agents.map((a) => a.name),
    rotations: () => rotations,
  };
}
const NO_429_RETRY = { network: { attempts: 0, delayMs: 0 }, 429: { attempts: 0, delayMs: 0 } };

const freeBody = () => ({ model: "deepseek-v4.1-flash-free", stream: false, messages: [{ role: "user", content: "hi" }], tools: [{ function: { name: "bash" } }] });

test("upstream：free 模型 429 ⇒ 请求内换出口重发，直到 200（额度穷尽优先）", async () => {
  const f = fakePool({ exhaustFirst: 1 });
  const c = createUpstreamClient({ authToken: "public", fetchImpl: f.fetchImpl, dispatcher: f.extDispatcher, keepAlive: false });
  const res = await c.chat(freeBody());
  assert.equal(res.status, 200, "第二个出口有额度 ⇒ 这一发必须救回来，而不是把 429 交出去");
  assert.equal(f.rotations(), 1);
  assert.equal(res._t.egressRotations, 1, "取证：本请求换了几次出口");
  assert.equal(res._t.egressRecovered, true);
});

test("upstream：出口池全耗尽 ⇒ 最后一个 429 原样交出（不无限重试、不伪造成功），次数有上限", async () => {
  const f = fakePool({ all429: true }); // 远超上限：必须在 MSLXDFF_V6_INREQUEST_RETRIES 处停
  const prev = process.env.MSLXDFF_V6_INREQUEST_RETRIES;
  process.env.MSLXDFF_V6_INREQUEST_RETRIES = "2";
  try {
    const c = createUpstreamClient({ authToken: "public", fetchImpl: f.fetchImpl, dispatcher: f.extDispatcher, keepAlive: false });
    const res = await c.chat(freeBody());
    assert.equal(res.status, 429, "榨干后如实交 429，serial-trial 的组员接力照常接管");
    assert.equal(f.rotations(), 2, "env 上限 2 就是 2，多一次都不许");
    assert.equal(res._t.egressRotations, 2);
    assert.equal(res._t.egressRecovered, false, "没救回来就不许记 recovered");
  } finally {
    if (prev === undefined) delete process.env.MSLXDFF_V6_INREQUEST_RETRIES; else process.env.MSLXDFF_V6_INREQUEST_RETRIES = prev;
  }
});

test("upstream：MSLXDFF_V6_INREQUEST_RETRIES=0 是逃生阀——一次都不换（envInt 的 >0 会把 0 吞回默认值，那是假开关）", async () => {
  const f = fakePool({ exhaustFirst: 1 });
  const prev = process.env.MSLXDFF_V6_INREQUEST_RETRIES;
  process.env.MSLXDFF_V6_INREQUEST_RETRIES = "0";
  try {
    const c = createUpstreamClient({ authToken: "public", fetchImpl: f.fetchImpl, dispatcher: f.extDispatcher, keepAlive: false });
    const res = await c.chat(freeBody());
    assert.equal(res.status, 429, "关掉后维持旧行为：429 原样交出");
    assert.equal(f.rotations(), 0, "0 就是 0，不许偷偷换一次");
  } finally {
    if (prev === undefined) delete process.env.MSLXDFF_V6_INREQUEST_RETRIES; else process.env.MSLXDFF_V6_INREQUEST_RETRIES = prev;
  }
});

test("upstream：无 rotateFor 的出口（直连/WARP）⇒ 请求内零换发（WARP 重注册 6~600s，设计上排除）", async () => {
  let n = 0;
  const c = createUpstreamClient({
    authToken: "public", keepAlive: false, retry: NO_429_RETRY,
    fetchImpl: async () => { n += 1; return limited(); },
    dispatcher: { dispatch: () => true, close: async () => {} }, // 普通 agent，没有 rotateFor
  });
  const res = await c.chat(freeBody());
  assert.equal(res.status, 429);
  assert.equal(n, 1, "不许对 WARP/直连出口做请求内重发");
});

test("upstream：非 free 模型的 429 不触发出口轮换（那是别家的账，白烧 v6 地址）", async () => {
  const f = fakePool({ exhaustFirst: 1 });
  const c = createUpstreamClient({ authToken: "public", fetchImpl: f.fetchImpl, dispatcher: f.extDispatcher, keepAlive: false });
  const res = await c.chat({ model: "some-paid-model", stream: false, messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 429, "原样交出");
  assert.equal(f.rotations(), 0, "付费模型的 429 不许动免费池的地址");
});

// ---------- SDK 引擎：429 free 必须委派 legacy（重试环在那儿） ----------

test("upstream-engine：SDK 通道撞 free-429 ⇒ 委派 legacy.chat 走请求内换出口；无 rotateFor 时不重复打流量", async () => {
  const f = fakePool({ exhaustFirst: 1 });
  const engine = createUpstreamEngine({
    authToken: "public",
    dispatcher: f.extDispatcher,
    fetchImpl: f.fetchImpl,
    keepAlive: false,
    sdkFactory: () => ({ chat: async () => limited() }), // SDK 首发恒 429
  });
  const res = await engine.chat({ model: "glm-5.3-flash-free", stream: true, messages: [{ role: "user", content: "hi" }], tools: [{ function: { name: "bash" } }] });
  assert.equal(res.status, 200, "SDK 的 429 必须交给 legacy 的换出口重试环救回来");
  assert.equal(f.rotations(), 1);

  // 对照：anonFirst（缺省）且出口无 rotateFor ⇒ 维持旧行为（SDK 的 429 直接返回，不再打一遍）
  let legacyCalls = 0;
  const engine2 = createUpstreamEngine({
    authToken: "public", keepAlive: false,
    fetchImpl: async () => { legacyCalls += 1; return limited(); },
    dispatcher: { dispatch: () => true, close: async () => {} },
    sdkFactory: () => ({ chat: async () => limited() }),
  });
  const res2 = await engine2.chat({ model: "glm-5.3-flash-free", stream: true, messages: [{ role: "user", content: "hi" }], tools: [{ function: { name: "bash" } }] });
  assert.equal(res2.status, 429);
  assert.equal(legacyCalls, 0, "救不了的场景不许白重放一遍请求");
});
