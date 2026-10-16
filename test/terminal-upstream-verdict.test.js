import { test } from "node:test";
import assert from "node:assert/strict";
import { runSerialTrial } from "../src/chat-pipeline/serial-trial.js";
import { runAutoRace } from "../src/chat-pipeline/auto-race.js";
import { classifyTerminalUpstream, terminalShortcircuitOff } from "../src/chat-pipeline/terminal-verdict.js";

// 现网原文（2026-10-15，~/.config/mslxdff/deepseek-v4.1-flash-free.log req=mv9m1d2v-n2y5）
const FREE_TIER_BODY = `{"type":"error","error":{"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."}}`;
const MODEL_GONE_BODY = `{"error":{"type":"model_not_found","message":"Model not found: opencode/deepseek-v4.1-flash-free. Did you mean: mimo-v2.6-flash-free?"}}`;
const ZCODE_SECURITY_BODY = `{"error":{"type":"security_reject","message":"zcode: 安全校验拒绝（code 3007）"}}`;
// 多 provider 明细体的真实排列：`model not found` 在前 400 字里，可恢复的 `rate limit` 落在 400 字之外。
// 判据只吃 400 字摘要就会把它误判成终局（= 静默停掉组网兜底），吃 ≤4KB 原文才能被反向护栏刹住。
const LATE_TRANSIENT_BODY = JSON.stringify({
  error: {
    message: "AllOf: model not found",
    metadata: {
      providers: [
        { provider: "pool-a", error: "model not found for provider pool-a" },
        ...Array.from({ length: 5 }, (_, i) => ({ provider: `route-${i}`, error: "upstream routing detail with no verdict in it, padding the multi-provider body" })),
        { provider: "pool-z", error: "Rate limit exceeded: too many requests, retry after 30s" },
      ],
    },
  },
});
assert.ok(LATE_TRANSIENT_BODY.length > 400, "夹具必须超过 400 字符，否则锁不住截断口径");
assert.ok(LATE_TRANSIENT_BODY.toLowerCase().indexOf("rate limit") > 400, "可恢复字样必须落在 400 字摘要之外");

// ---------- 纯函数：判据边界 ----------

test("classifyTerminalUpstream: 免费层身份判决判终局，4xx 任意码都收（上游挪码不失明），文案裹 quota 也不漏", () => {
  assert.equal(classifyTerminalUpstream(403, FREE_TIER_BODY).kind, "free-tier-blocked");
  assert.equal(classifyTerminalUpstream(404, FREE_TIER_BODY).kind, "free-tier-blocked", "同一具名判决不该被状态码卡掉");
  assert.equal(classifyTerminalUpstream(400, `{"error":{"type":"FreeTierError","message":"quota exceeded"}}`).kind, "free-tier-blocked");
  assert.equal(classifyTerminalUpstream(500, FREE_TIER_BODY).terminal, false, "5xx 永远可恢复，不许终局");
});

test("classifyTerminalUpstream: 模型 id 不存在（400/403/404/422）判终局，中英文都收", () => {
  for (const code of [400, 403, 404, 422]) {
    const r = classifyTerminalUpstream(code, MODEL_GONE_BODY);
    assert.equal(r.terminal, true, `status=${code} 应判终局`);
    assert.equal(r.kind, "model-gone");
  }
  assert.equal(classifyTerminalUpstream(400, "ProviderModelNotFoundError: Model not found: opencode/x").kind, "model-gone");
  assert.equal(classifyTerminalUpstream(404, '{"error":{"message":"模型不存在或未找到"}}').kind, "model-gone");
  assert.equal(classifyTerminalUpstream(403, '{"message":"该模型已下线"}').kind, "model-gone");
});

test("classifyTerminalUpstream: 可恢复拒绝一律不终局（换号/换节点可能就好）", () => {
  const passes = [
    [403, ZCODE_SECURITY_BODY],                      // 坏号型安全拒绝
    [403, `{"code":"403","message":{"isQueued":true,"retryAfterSeconds":30}}`], // 限流裹 403
    [401, '{"error":"invalid api key"}'],
    [403, '{"error":"Missing API key."}'],
    [429, "upstream rate limit, model mimo not found"], // not-found 字样裹在限流里也不许终局
    [400, LATE_TRANSIENT_BODY],                         // 反向护栏字样在 400 字之后
    [500, "internal error mentioning model not found"],
    [403, ""],                                       // 空体（读超时/无 body）保守放过
    [200, FREE_TIER_BODY],                           // 非失败态
    [404, '{"error":{"message":"no such file"}}'],    // not found 但没说 model
    [400, '{"error":{"message":"max_tokens must be <= 8192 for this model"}}'], // 参数错，别误判成模型不存在
  ];
  for (const [code, body] of passes) {
    assert.equal(classifyTerminalUpstream(code, body).terminal, false, `status=${code} body=${body.slice(0, 40)} 不该终局`);
  }
});

test("terminalShortcircuitOff: 缺省开（终局不接力），MSLXDFF_TERMINAL_SHORTCIRCUIT=0 回旧行为", () => {
  assert.equal(terminalShortcircuitOff({}), false);
  assert.equal(terminalShortcircuitOff({ MSLXDFF_TERMINAL_SHORTCIRCUIT: "0" }), true);
  assert.equal(terminalShortcircuitOff({ MSLXDFF_TERMINAL_SHORTCIRCUIT: "off" }), true);
  assert.equal(terminalShortcircuitOff({ MSLXDFF_TERMINAL_SHORTCIRCUIT: "1" }), false, "开关方向必须与名字同向：设 1 是开，不是关");
});

// ---------- 接线：串行 trial 的短路行为 ----------

// 桩必须像 Node 一样校验头值：非 latin1（裸中文）或 CR/LF 即 ERR_INVALID_CHAR。
// 生产码这些 setHeader 外面套着 try{}catch{}，桩不校验就会「头静默消失」也测不出来。
function fakeRes() {
  return {
    statusCode: 0, body: "", headers: {}, headersSent: false, writableEnded: false,
    setHeader(k, v) {
      const s = String(v);
      if (/[^\x00-\xFF]/.test(s) || /[\r\n]/.test(s)) {
        const e = new Error(`Invalid character in header content ["${k}"]`);
        e.code = "ERR_INVALID_CHAR";
        throw e;
      }
      this.headers[k] = s;
    },
    getHeader(k) { return this.headers[k]; },
    end(b) { this.body = b || ""; this.writableEnded = true; },
  };
}

const resp = (status, bodyText) => {
  const r = new Response(bodyText, { status, headers: { "content-type": "application/json" } });
  r._t = { attempts: [], waitMs: 0, totalMs: 6000 };
  return r;
};
const up = (status, bodyText) => async () => resp(status, bodyText);

function ctx(over = {}) {
  const res = over.res || fakeRes();
  const c = {
    order: over.order || ["m"], reqId: "r1", requested: over.requested || "m",
    body: { stream: false, model: over.requested || "m", messages: [{ role: "user", content: "hi" }] },
    hops: 0, useAuto: over.useAuto ?? false, lockModel: "", plugins: [],
    auto: over.auto ?? null, upstream: { chat: over.chat || up(403, FREE_TIER_BODY) },
    peers: over.peers ?? { ordered: () => [{ url: "http://p1:8989", token: "t" }] },
    groups: null, bus: null, token: "t",
    canFallback: over.canFallback ?? false, canForwardPeers: true,
    perf0: 0, stages: [], mark: () => {}, evt: over.evt || (() => {}),
    logCall: over.logCall || (() => {}), logError: over.logError || (() => {}), done: null, handlerCtx: {},
    startedAt: Date.now(), logs: null, shareKeys: {}, res,
  };
  return { res, c };
}

// 组员中继到底跑不跑，取决于 shouldUseGroupForModel（读真实 state 文件 + MSLXDFF_USE_GROUP）。
// 这些用例必须把 env 钉成 1：否则 useGroup=off 时「peer 没被调用」是环境给的假绿，短路删掉也照样绿。
const GROUP_ON = { MSLXDFF_USE_GROUP: "1", MSLXDFF_TERMINAL_SHORTCIRCUIT: undefined };

async function withEnv(env, fn) {
  const prev = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(env)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
}

function spyDeps(counts, over = {}) {
  return {
    viaRoute: async () => ({ handled: false }),
    hedge: async ({ upRes }) => ({ handled: false, upRes }),
    localRelay: async () => { counts.local += 1; return { handled: true, wrotePayload: true }; },
    peerRelay: async () => { counts.peer += 1; return { handled: false, lastErr: { model: "m", upstream: null, status: 502, message: "peers failed: ..." } }; },
    broadbandRelay: async () => { counts.broad += 1; return { handled: false }; },
    exhaustedLocal: async (arg) => {
      counts.exhaust += 1;
      counts.sawTerminalHeader = arg.res.headers["x-mslxdff-terminal"] ?? null;
      counts.sawLastErr = arg.lastErr;
      // 收场在现网是 relay **原响应**（原状态码 + 原字节），并由它自己 logCall + 落 result/client-response。
      // 这里照它的契约模拟一次：断言「我们把还能读的原始 Response 交了出去」，而不是自己 json() 一份二手摘要。
      if (arg.lastErr?.upstream?.status) {
        arg.res.statusCode = arg.lastErr.upstream.status;
        arg.res.body = await arg.lastErr.upstream.text();
        arg.logCall?.(arg.lastErr.model, arg.lastErr.status);
      }
      return true;
    },
    exhaustedAll: over.exhaustedAll,
  };
}

test("终局 403（免费层）：不跑组员，把**原上游响应**交给既有收场，头与事件都留痕", async () => {
  const counts = { peer: 0, broad: 0, local: 0, exhaust: 0, sawTerminalHeader: null };
  const evts = [];
  const calls = [];
  const { res, c } = ctx({ evt: (t, d) => evts.push({ t, ...d }), logCall: (m, s) => calls.push([m, s]) });
  await withEnv(GROUP_ON, () => runSerialTrial(c, spyDeps(counts)));
  assert.equal(counts.peer, 0, "终局判决不许进组员接力（useGroup 已钉成 on，0 是真 0）");
  assert.equal(counts.broad, 0, "也不许进宽带组员");
  assert.equal(counts.exhaust, 1, "收场交回 exhaustedLocal（它负责 relay + logCall + result/client-response）");
  assert.equal(res.statusCode, 403, "客户端拿到的是上游的 403，不是接力揉出来的 502");
  assert.match(res.body, /FreeTierError/, "上游原文必须原样送达（不是 400 字摘要、不是 [object Object]）");
  assert.deepEqual(calls, [["m", 403]], "calls.log 要有这条 403（旧行为只留 502 且慢一分多钟）");
  assert.ok(evts.some((e) => e.t === "upstream-terminal" && e.kind === "free-tier-blocked" && e.peersSkipped === true), "trace 要留下「为什么没问组员」");
  // result/client-response 由收场出口负责（现网 handleExhaustedLocal 自己落两条）；这里断言的是
  // 「交出去的 lastErr 够它落对账」：状态码跟上游、原响应还可读、模型名在场。
  assert.equal(counts.sawLastErr?.status, 403, "收场拿到的状态码必须是上游的 403，不是接力揉的 502");
  assert.equal(counts.sawLastErr?.model, "m");
  assert.equal(typeof counts.sawLastErr?.upstream?.text, "function", "必须把原响应本体交给收场（它 relay 原字节）");
  assert.equal(counts.sawTerminalHeader, "free-tier-blocked", "回显头要在收场前就落好");
  assert.ok(!/[^\x00-\xFF]/.test(String(counts.sawTerminalHeader)), "头值必须 ASCII 安全（Node 拒非 latin1，且那行套着 try/catch 会静默丢头）");
  assert.equal(evts.filter((e) => e.t === "upstream-error").length, 1, "同一发失败只许一条 upstream-error");
});

test("终局 404（上游不认这个模型 id）同样短路，头是 model-gone", async () => {
  const counts = { peer: 0, broad: 0, local: 0, exhaust: 0, sawTerminalHeader: null };
  const { res, c } = ctx({ chat: up(404, MODEL_GONE_BODY) });
  await withEnv(GROUP_ON, () => runSerialTrial(c, spyDeps(counts)));
  assert.equal(counts.peer, 0);
  assert.equal(res.statusCode, 404);
  assert.match(res.body, /model_not_found/);
  assert.equal(counts.sawTerminalHeader, "model-gone");
});

test("判据吃的是原文不是 400 字摘要：可恢复字样在摘要之外时不许误短路", async () => {
  const counts = { peer: 0, broad: 0, local: 0, exhaust: 0 };
  const evts = [];
  const { c } = ctx({ chat: up(400, LATE_TRANSIENT_BODY), evt: (t, d) => evts.push({ t, ...d }) });
  await withEnv(GROUP_ON, () => runSerialTrial(c, spyDeps(counts)));
  assert.equal(evts.some((e) => e.t === "upstream-terminal"), false, "rate limit 字样落在 400 字之外也必须被护栏看到");
  assert.equal(counts.peer, 1, "误判成终局就会静默停掉组网兜底——这条是反向哨兵");
});
test("非终局的 5xx：不许短路，组员接力照常跑", async () => {
  const counts = { peer: 0, broad: 0, local: 0, exhaust: 0 };
  const { c } = ctx({ chat: up(503, "bad gateway") });
  await withEnv(GROUP_ON, () => runSerialTrial(c, spyDeps(counts)));
  assert.equal(counts.peer, 1, "503 只是这一发的抖动，仍该问组员");
});

test("坏号型 403（zcode security_reject）：不许短路，换号换节点可能就好", async () => {
  const counts = { peer: 0, broad: 0, local: 0, exhaust: 0 };
  const evts = [];
  const { c } = ctx({ chat: up(403, ZCODE_SECURITY_BODY), evt: (t, d) => evts.push({ t, ...d }) });
  await withEnv(GROUP_ON, () => runSerialTrial(c, spyDeps(counts)));
  assert.equal(counts.peer, 1, "坏号型拒绝是可恢复态，绝不能当终局判决");
  assert.equal(evts.some((e) => e.t === "upstream-terminal"), false, "更不许落终局事件");
});

test("逃生阀 MSLXDFF_TERMINAL_SHORTCIRCUIT=0：回到旧行为——终局判决也照跑接力", async () => {
  const counts = { peer: 0, broad: 0, local: 0, exhaust: 0 };
  const { c } = ctx({ chat: up(403, FREE_TIER_BODY) });
  await withEnv({ ...GROUP_ON, MSLXDFF_TERMINAL_SHORTCIRCUIT: "0" }, () => runSerialTrial(c, spyDeps(counts)));
  assert.equal(counts.peer, 1, "逃生阀打开时必须回到「任何失败都问组员」的旧口径");
});

test("serial-trial auto 多候选：某模型终局 → 立刻换下一候选，不连坐也不问组员", async () => {
  const counts = { peer: 0, broad: 0, local: 0, exhaust: 0 };
  const evts = [];
  let n = 0;
  const chat = async () => {
    n += 1;
    return n === 1 ? resp(403, FREE_TIER_BODY) : resp(200, JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  };
  const { res, c } = ctx({ order: ["dead-free", "good-model"], requested: "auto", useAuto: true, canFallback: true, chat, evt: (t, d) => evts.push({ t, ...d }) });
  await withEnv(GROUP_ON, () => runSerialTrial(c, spyDeps(counts)));
  assert.equal(counts.peer, 0, "第一个候选的终局判决不该拖组员下水");
  assert.equal(counts.local, 1, "第二个候选正常送达");
  assert.ok(evts.some((e) => e.t === "fallback" && e.from === "dead-free" && /terminal free-tier-blocked/.test(e.reason)), "failover 理由要写明是终局判决");
  assert.equal(res.statusCode, 0, "成功路径由 localRelay 负责，这里不该写响应");
});

test("serial-trial auto：最后一个候选终局 → 收场发原文而不是 502 \"peers failed\"", async () => {
  const counts = { peer: 0, broad: 0, local: 0, exhaust: 0 };
  const { res, c } = ctx({ order: ["a-free", "b-free"], requested: "auto", useAuto: true, canFallback: true, chat: up(403, FREE_TIER_BODY) });
  await withEnv(GROUP_ON, () => runSerialTrial(c, spyDeps(counts)));
  assert.equal(counts.peer, 0);
  assert.equal(counts.exhaust, 1);
  assert.equal(res.statusCode, 403, "两发都被同一判决拒了，客户端要看得到判决本身");
  assert.match(res.body, /FreeTierError/);
});

// ---------- 接线：auto 并发竞速出口（chat 门缺省路径，serial-trial 那条短路救不到它） ----------

test("auto 并发竞速全挂且同源终局：收场拿到的 lastErr 带原响应，不再是 502 \"all concurrent candidates failed\"", async () => {
  const evts = [];
  let saw = null;
  const auto = { statuses: () => ({}), isCooling: () => false, candidates: async () => ["f1", "f2"], recordError: async () => {}, recordOk: async () => {} };
  const { res, c } = ctx({
    order: ["f1", "f2"], requested: "auto", useAuto: true, auto,
    chat: async () => resp(403, FREE_TIER_BODY),
    evt: (t, d) => evts.push({ t, ...d }),
  });
  const deps = {
    localRelay: async () => ({ handled: true }),
    exhaustedAll: async (arg) => {
      saw = arg.lastErr;
      if (arg.lastErr?.upstream?.status) { arg.res.statusCode = arg.lastErr.upstream.status; arg.res.body = await arg.lastErr.upstream.text(); }
      return true;
    },
  };
  await withEnv(GROUP_ON, () => runAutoRace({ ...c, res }, deps));
  assert.ok(saw, "竞速收场必须被调用");
  assert.equal(saw.status, 403, "状态码跟随上游判决，不是兜底 502");
  assert.ok(saw.upstream, "必须把原响应交给收场（现网由它 relay 原字节）");
  assert.equal(saw.terminal, "free-tier-blocked");
  assert.ok(evts.some((e) => e.t === "upstream-terminal" && e.via === "auto-race"), "竞速出口也要留终局痕迹");
  assert.equal(res.statusCode, 403);
  assert.match(res.body, /FreeTierError/);
  assert.equal(res.headers["x-mslxdff-terminal"], "free-tier-blocked", "竞速出口的取证要与串行一致（同头同名）");
});

test("auto 并发竞速：非终局失败保持旧形状（不伪造判决）", async () => {
  let saw = null;
  const auto = { statuses: () => ({}), isCooling: () => false, candidates: async () => ["p1", "p2"], recordError: async () => {}, recordOk: async () => {} };
  const { res, c } = ctx({ order: ["p1", "p2"], requested: "auto", useAuto: true, auto, chat: async () => resp(503, "bad gateway") });
  await withEnv(GROUP_ON, () => runAutoRace({ ...c, res }, {
    localRelay: async () => ({ handled: true }),
    exhaustedAll: async (arg) => { saw = arg.lastErr; return true; },
  }));
  assert.equal(saw.upstream, undefined, "5xx 不该被当终局判决透传");
  assert.match(saw.message, /all concurrent candidates failed/, "旧收场文案保持逐字不变");
});
