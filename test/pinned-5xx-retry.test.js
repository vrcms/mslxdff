// 用户口径（2026-10-23）：指定模型撞 5xx → 等 5s 重试，连续 3 次；仍 5xx 才换 1 个节点；
// 该节点仍 5xx 就返回客户端。429 不等待（额度按出口 IP），auto 不受影响。
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSerialTrial } from "../src/chat-pipeline/serial-trial.js";
import { chatWith5xxRetry, http5xxRetryCfg, isHttp5xx } from "../src/chat-pipeline/upstream-5xx-retry.js";
import { serialTryPeers } from "../src/routes/peer-serial.js";
import { handlePeerRelay } from "../src/routes/chat/peer-handler.js";

async function withEnv(env, fn) {
  const prev = {};
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try { return await fn(); } finally {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

const RETRY_ENV = { MSLXDFF_5XX_RETRIES: "3", MSLXDFF_5XX_RETRY_DELAY_MS: "1" };

function failRes(status = 503) {
  return {
    status,
    headers: new Headers(),
    body: { cancelled: false, cancel() { this.cancelled = true; } },
    clone() { return { text: async () => "upstream busy" }; },
    _t: null,
  };
}

function okRes() {
  return { status: 200, headers: new Headers(), body: null, _t: null };
}

function baseCtx(over = {}) {
  return {
    order: ["m"], reqId: "r5", requested: "m",
    body: { stream: false, model: "m", messages: [{ role: "user", content: "hi" }] },
    hops: 0, useAuto: false, lockModel: "", plugins: [],
    auto: null, upstream: over.upstream, peers: over.peers ?? null, groups: over.groups ?? null,
    bus: null, token: "t", canFallback: false, canForwardPeers: false,
    perf0: 0, stages: [], mark: () => {}, evt: over.evt || (() => {}),
    logCall: () => {}, logError: () => {}, done: null,
    handlerCtx: { reqId: "r5", hops: 0, orderLen: 1, idx: 0, ...(over.handlerCtx || {}) },
    res: over.res ?? {}, startedAt: Date.now(), logs: null, shareKeys: {},
    ...over.ctx,
  };
}

// ---------- 配置 / 纯函数 ----------

test("默认：3 次、5s；空串与非法值回落默认", async () => {
  await withEnv({ MSLXDFF_5XX_RETRIES: undefined, MSLXDFF_5XX_RETRY_DELAY_MS: undefined }, () => {
    assert.deepEqual(http5xxRetryCfg(), { retries: 3, delayMs: 5000 });
  });
  await withEnv({ MSLXDFF_5XX_RETRIES: "", MSLXDFF_5XX_RETRY_DELAY_MS: "oops" }, () => {
    assert.deepEqual(http5xxRetryCfg(), { retries: 3, delayMs: 5000 }, "手滑不能静默关掉重试");
  });
});

test("0 = 关闭重试（逃生阀）", async () => {
  await withEnv({ MSLXDFF_5XX_RETRIES: "0", MSLXDFF_5XX_RETRY_DELAY_MS: "0" }, () => {
    assert.deepEqual(http5xxRetryCfg(), { retries: 0, delayMs: 0 });
  });
});

test("isHttp5xx：只认 500~599", () => {
  assert.equal(isHttp5xx(500), true);
  assert.equal(isHttp5xx(599), true);
  assert.equal(isHttp5xx(429), false);
  assert.equal(isHttp5xx(404), false);
  assert.equal(isHttp5xx(undefined), false);
});

test("chatWith5xxRetry：非指定模型 / 非 5xx / 客户端已断开都不重试", async () => {
  let calls = 0;
  const call = async () => { calls += 1; return failRes(503); };
  assert.equal((await chatWith5xxRetry({ call, singleModel: false })).status, 503);
  assert.equal(calls, 1, "auto 不重试");
  calls = 0;
  const okCall = async () => { calls += 1; return okRes(); };
  assert.equal((await chatWith5xxRetry({ call: okCall, singleModel: true })).status, 200);
  assert.equal(calls, 1, "成功不重试");
  calls = 0;
  await chatWith5xxRetry({ call, singleModel: true, isClosed: () => true });
  assert.equal(calls, 1, "客户端已断开不再打上游");
});

// ---------- 串行 trial 接线 ----------

test("指定模型 5xx：等 5s（测试用 1ms）重试 3 次，共 4 发，仍 5xx 交收场", async () => {
  await withEnv(RETRY_ENV, async () => {
    let chats = 0;
    const events = [];
    const upstream = { chat: async () => { chats += 1; return failRes(503); } };
    let last = null;
    await runSerialTrial(baseCtx({ upstream, evt: (n, d) => events.push({ n, d }) }), {
      exhaustedLocal: async (o) => { last = o; return true; },
    });
    assert.equal(chats, 4, "首发 + 3 次重试");
    const rs = events.filter((e) => e.n === "upstream-5xx-retry");
    assert.deepEqual(rs.map((e) => e.d.retry), [1, 2, 3]);
    assert.equal(rs[0].d.delayMs, 1);
    assert.equal(last?.lastErr?.status, 503, "收场拿到的是最后一次 5xx");
  });
});

test("指定模型 5xx 后重试救回：2 发即成功，不再换节点", async () => {
  await withEnv(RETRY_ENV, async () => {
    let chats = 0;
    const events = [];
    const upstream = { chat: async () => { chats += 1; return chats === 1 ? failRes(502) : okRes(); } };
    let peerCalls = 0;
    const r = await runSerialTrial(baseCtx({ upstream, evt: (n, d) => events.push({ n, d }), ctx: { canForwardPeers: true, peers: { ordered: () => [] } } }), {
      peerRelay: async () => { peerCalls += 1; return { handled: true }; },
      localRelay: async () => ({ handled: true }),
      exhaustedLocal: async () => true,
    });
    assert.equal(r.done, true);
    assert.equal(chats, 2);
    assert.equal(peerCalls, 0, "救回后不该再问节点");
    assert.equal(events.filter((e) => e.n === "upstream-5xx-retry").length, 1);
  });
});

test("429 不等待：只发 1 次，直接走原有节点路径", async () => {
  await withEnv(RETRY_ENV, async () => {
    let chats = 0;
    const events = [];
    const upstream = { chat: async () => { chats += 1; return failRes(429); } };
    let single = null;
    const r = await runSerialTrial(baseCtx({ upstream, evt: (n, d) => events.push({ n, d }), ctx: { canForwardPeers: true, peers: {} } }), {
      peerRelay: async (o) => { single = o.handlerCtx?.singlePeer === true; return { handled: true }; },
      exhaustedLocal: async () => true,
    });
    assert.equal(r.done, true);
    assert.equal(chats, 1, "额度类不重试");
    assert.equal(events.some((e) => e.n === "upstream-5xx-retry"), false);
    assert.equal(single, false, "429 仍走多节点");
  });
});

test("auto 模式 5xx 不启用这套重试（原路径直发）", async () => {
  await withEnv(RETRY_ENV, async () => {
    let chats = 0;
    const upstream = { chat: async () => { chats += 1; return failRes(503); } };
    await runSerialTrial(baseCtx({ upstream, ctx: { useAuto: true } }), {
      exhaustedLocal: async () => true,
    });
    assert.equal(chats, 1);
  });
});

test("指定模型 5xx 耗尽：只换 1 个节点，该节点失败后跳过宽带直接返回", async () => {
  await withEnv({ ...RETRY_ENV, MSLXDFF_USE_GROUP: "1" }, async () => {
    const upstream = { chat: async () => failRes(503) };
    let peerCtx = null;
    let broadband = 0;
    let exhausted = null;
    await runSerialTrial(
      baseCtx({ upstream, ctx: { canForwardPeers: true, peers: { ordered: () => [] }, groups: {} } }),
      {
        peerRelay: async (o) => {
          peerCtx = o.handlerCtx;
          return { handled: false, lastErr: { model: "m", upstream: null, status: 503, message: "peers failed: one node 503" } };
        },
        broadbandRelay: async () => { broadband += 1; return { handled: true }; },
        exhaustedLocal: async (o) => { exhausted = o; return true; },
      },
    );
    assert.equal(peerCtx?.singlePeer, true, "5xx 只允许换一个节点");
    assert.equal(broadband, 0, "5xx 不再走宽带");
    assert.equal(exhausted?.lastErr?.status, 503);
  });
});

test("MSLXDFF_5XX_RETRIES=0：整套功能关闭，5xx 回到旧的全节点路径", async () => {
  await withEnv({ MSLXDFF_5XX_RETRIES: "0", MSLXDFF_5XX_RETRY_DELAY_MS: "1", MSLXDFF_USE_GROUP: "1" }, async () => {
    let chats = 0;
    const upstream = { chat: async () => { chats += 1; return failRes(503); } };
    let single = null;
    await runSerialTrial(baseCtx({ upstream, ctx: { canForwardPeers: true, peers: { ordered: () => [] } } }), {
      peerRelay: async (o) => { single = o.handlerCtx?.singlePeer === true; return { handled: true }; },
      exhaustedLocal: async () => true,
    });
    assert.equal(chats, 1, "不重试");
    assert.equal(single, false, "也不限制只换一个节点");
  });
});

// ---------- 单节点选择 ----------

function peerStub() {
  const p1 = { url: "http://127.0.0.1:1", token: "t", name: "a" };
  const p2 = { url: "http://127.0.0.1:2", token: "t", name: "b" };
  return {
    p1, p2,
    peers: {
      ordered: () => [p1, p2],
      orderedByLastError: () => [],
      coolingByLastError: () => [],
      recordResult: async () => {},
      recordError: async () => {},
      stat: () => null,
      isHot: () => false,
    },
  };
}

test("peer-handler singlePeer：只把链头一个节点交给竞速，第二批不再跑", async () => {
  const { p1, peers } = peerStub();
  let got = null;
  let lastErrCalled = 0;
  peers.orderedByLastError = () => { lastErrCalled += 1; return []; };
  await handlePeerRelay({
    model: "m", body: { stream: true, model: "m" }, lastErr: null, requested: "m",
    useAuto: false, lockModel: null, auto: null, peers,
    handlerCtx: { reqId: "t1", hops: 0, orderLen: 1, idx: 0, singlePeer: true },
    evt: () => {}, logCall: () => {}, logError: () => {}, mark: () => {},
    perf0: Date.now(), stages: [], startedAt: Date.now(), plugins: [], res: {},
    deps: { racePeerCandidates: async (cands) => { got = cands; return null; } },
  });
  assert.equal(got.length, 1, "只允许一个候选");
  assert.equal(got[0].url, p1.url, "按 ordered 链头取");
  assert.equal(lastErrCalled, 0, "链头非空时不再叠加后两批");
});

test("peer-handler singlePeer：ordered 空时退到最早失败节点，但同样只取一个", async () => {
  const { p1, p2, peers } = peerStub();
  peers.ordered = () => [];
  peers.orderedByLastError = () => [p2, p1];
  let got = null;
  await handlePeerRelay({
    model: "m", body: { stream: true, model: "m" }, lastErr: null, requested: "m",
    useAuto: false, lockModel: null, auto: null, peers,
    handlerCtx: { reqId: "t2", hops: 0, orderLen: 1, idx: 0, singlePeer: true },
    evt: () => {}, logCall: () => {}, logError: () => {}, mark: () => {},
    perf0: Date.now(), stages: [], startedAt: Date.now(), plugins: [], res: {},
    deps: { racePeerCandidates: async (cands) => { got = cands; return null; } },
  });
  assert.deepEqual(got.map((x) => x.url), [p2.url]);
});

test("serialTryPeers peerMaxPeers=1：IPv4 只打一个，且不进 IPv6 阶段", async () => {
  const p1 = { url: "http://127.0.0.1:1", token: "t" };
  const p2 = { url: "http://127.0.0.1:2", token: "t" };
  const p6 = { url: "http://[::1]:3", token: "t", hasV6: true };
  const triedUrls = new Set();
  const calls = [];
  const res = await serialTryPeers({
    candidates: [p1, p2],
    v6Candidates: [p6],
    ctx: {
      peerMaxPeers: 1, triedUrls, reqId: "t3", hops: 0, model: "m",
      body: { messages: [] }, plugins: [], peerErrors: [],
      evt: () => {},
      peers: { stat: () => null, recordError: async () => {}, recordResult: async () => {} },
    },
    tried: triedUrls,
    deps: {
      resolvePeerTarget: async (ctx, peer) => ({ peer, target: "m" }),
      forwardToPeer: async (peer) => { calls.push(peer.url); return failRes(503); },
      peerName: () => null,
      recordLater: (fn) => fn(),
      summarizeRequest: () => ({ messages: 0 }),
      runHook: async () => {},
      errMsg: (e) => String(e?.message || e),
      perAttemptCap: 1000, deadline: 0, budgetMs: 0,
      warmPeer: async () => {},
    },
  });
  assert.equal(res, null);
  assert.deepEqual(calls, [p1.url], "只打链头一个，失败即停（不试 p2 / p6）");
});

test("serialTryPeers 默认（无 peerMaxPeers）：仍按整链串行", async () => {
  const p1 = { url: "http://127.0.0.1:1", token: "t" };
  const p2 = { url: "http://127.0.0.1:2", token: "t" };
  const calls = [];
  await serialTryPeers({
    candidates: [p1, p2], v6Candidates: [], tried: new Set(),
    ctx: {
      triedUrls: new Set(), reqId: "t4", hops: 0, model: "m",
      body: { messages: [] }, plugins: [], peerErrors: [], evt: () => {},
      peers: { stat: () => null, recordError: async () => {}, recordResult: async () => {} },
    },
    deps: {
      resolvePeerTarget: async (ctx, peer) => ({ peer, target: "m" }),
      forwardToPeer: async (peer) => { calls.push(peer.url); return failRes(503); },
      peerName: () => null, recordLater: (fn) => fn(), summarizeRequest: () => ({}),
      runHook: async () => {}, errMsg: (e) => String(e?.message || e),
      perAttemptCap: 1000, deadline: 0, budgetMs: 0, warmPeer: async () => {},
    },
  });
  assert.deepEqual(calls, [p1.url, p2.url]);
});
