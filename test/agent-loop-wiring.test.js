// 接线验证：agent 回路捕获（talk/full）挂在真实转发路径上的两个落盘点（relay-pipeline / exhausted-handler），
// 锁三件事：① 只捕本机自发流量（hops>0 不落）② capture 与 talk.log 生死独立 ③ 纯旁路（响应字节/状态码/结局零变化）。
// 隔离照 test/talk-log.test.js：MSLXDFF_DAEMON_DIR 每例 mkdtemp（talk/ 与 talk/full/ 随之落）。
// MSLXDFF_TALK_FULL 在本文件顶部、import 被测模块之前设（test/AGENTS.md 硬规：模块级常量 import 时读 env；
// node --test 每文件独立进程 → 只影响本文件）。异步落盘断言前一律 await flushAgentLoop()。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MSLXDFF_TALK_FULL = "1";
// 组合路径会触达 recordModelStats / recordChatUsage → state 指到独立 tmp，不碰真实 state.json
process.env.MSLXDFF_STATE_FILE = join(mkdtempSync(join(tmpdir(), "mslxdff-wire-state-")), "state.json");

const { createRelayPipeline } = await import("../src/routes/chat/relay-pipeline.js");
const { handleExhaustedLocal, handleExhaustedAll } = await import("../src/routes/chat/exhausted-handler.js");
const { buildFallbackInfo } = await import("../src/routes/fallback.js");
const { createChatPipeline } = await import("../src/chat-pipeline/index.js");
const { agentLoopFile, flushAgentLoop, recordAgentLoop } = await import("../src/talk-full.js");
const { talkLogFile, resetTalkLogCache } = await import("../src/talk-log.js");
const { startServer } = await import("../src/server.js");

const sha1hex = (s) => createHash("sha1").update(String(s)).digest("hex");
const norm = (raw) => `${sha1hex(raw).slice(-12)}-${String(raw).slice(0, 8)}`; // 落盘形态：sha1尾12-原值前8
/** 正文桶用字面量构造（不 import 并行改动中的 stream-scan.js）：talk-full 只读这五个字段。 */
const bucket = (over = {}) => ({ reasoning: [], content: [], tools: [], n: 0, capped: false, ...over });
const SSE = (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;

function withCapture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-wire-"));
  const old = process.env.MSLXDFF_DAEMON_DIR;
  process.env.MSLXDFF_DAEMON_DIR = dir;
  resetTalkLogCache();
  return (async () => {
    try {
      return await fn(dir);
    } finally {
      await flushAgentLoop().catch(() => {});
      if (old === undefined) delete process.env.MSLXDFF_DAEMON_DIR;
      else process.env.MSLXDFF_DAEMON_DIR = old;
      resetTalkLogCache();
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

/** 排空写队列后读该模型的语料行（无文件 = 空数组）；坏行直接抛错并带行号。 */
async function rows(model) {
  await flushAgentLoop();
  const file = agentLoopFile(model);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l, i) => {
    try { return JSON.parse(l); } catch (e) { throw new Error(`第 ${i + 1} 行不是合法 JSON: ${e.message} :: ${l.slice(0, 120)}`); }
  });
}
/** 不 flush 的裸读（关停钩子那条测试用：断言"close() 返回时盘上已齐"）。 */
function rawRows(model) {
  const file = agentLoopFile(model);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
}

function fakeRes() {
  return {
    statusCode: 0, headers: {}, wrote: [], ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = String(v); },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    write(c) { this.wrote.push(Buffer.isBuffer(c) ? c.toString("utf8") : String(c)); return true; },
    end(c) { if (c != null) this.wrote.push(Buffer.isBuffer(c) ? c.toString("utf8") : String(c)); this.ended = true; return this; },
    on() { return this; },
    removeListener() { return this; },
  };
}
const upEchoRes = () => new Response("", { headers: { "x-mslxdff-upstream": "api.wire.test", "x-mslxdff-workbuddy-uid": "u9" } });

/** pipeline-seam 桩：假 relay 照 stream.js 的样子往 res 写帧并交回 out.detail.talk（桶由调用方给）。 */
function makePipe({ talk, chunks, status = 200, emptyTurn = false, perfNow = () => 1000, totalMs = 200 }) {
  const events = [];
  const pipe = createRelayPipeline({
    relay: async (res) => {
      res.statusCode = status;
      res.setHeader("content-type", "text/event-stream");
      for (const c of chunks) { res.write(c); }
      res.end();
      return {
        status, ttfMs: 10, totalMs, aborted: false, interrupted: false, preflightMs: 0,
        detail: {
          chars: emptyTurn ? 0 : 4, toolCalls: 0, exitReason: emptyTurn ? "empty-turn-hold" : "normal",
          chatShaped: emptyTurn, sawFinishReason: emptyTurn ? "stop" : null, wroteChunks: chunks.length,
          stallHits: 0, maxGapMs: 0, usage: { prompt_tokens: 3, completion_tokens: 4 }, talk,
        },
      };
    },
    buildFallbackInfo,
    auto: { recordOk: async () => {}, recordError: async () => {}, recordLatency: async () => {} },
    evt: (type, data) => events.push({ type, data }),
    mark: () => {}, logCall: () => {}, logError: () => {}, perfNow,
    constants: { STREAM_TIMEOUT_MS: 25_000, SLOW_TOTAL_MS: 20_000, STALL_TIMEOUT_MS: 0, SCORE_STALL_MS: 15_000 },
  });
  return { pipe, events };
}

async function runPipeline({ model, talk, chunks = [SSE("回答")], status = 200, emptyTurn = false, handlerCtx }) {
  const res = fakeRes();
  const { pipe, events } = makePipe({ talk, chunks, status, emptyTurn });
  const r = await pipe.execute({
    res, upRes: upEchoRes(),
    body: { stream: true, messages: [{ role: "system", content: "接线用的 system 全文" }, { role: "user", content: "接线问题" }] },
    requested: model, actual: model, via: "local", handlerCtx,
  });
  return { r, res, events };
}

// ── 1. 隐私判据：组员转发的对话不落本机盘，而 talk.log 照旧（两条通道生死独立） ──────────
test("接线 hops=1（组员转发）：语料零条连目录都不建，talk/*.log 照旧落正文", async () => {
  await withCapture(async (dir) => {
    const { r } = await runPipeline({
      model: "peer/pmodel", talk: bucket({ content: ["组员的那句回答"], n: 8 }),
      handlerCtx: { reqId: "r-peer", hops: 1, sessionId: "ses_peer_head", clientIp: "198.51.100.4" },
    });
    assert.equal(r.handled, true, "捕获判据不得影响转发结局");
    assert.equal((await rows("peer/pmodel")).length, 0);
    assert.equal(existsSync(agentLoopFile("peer/pmodel")), false, "hops>0 不得进回路语料（spec：只捕获本机自发流量）");
    assert.equal(existsSync(join(dir, "talk", "full")), false, "连 talk/full 目录都不该出现");
    const talkText = readFileSync(talkLogFile("peer/pmodel"), "utf8");
    assert.ok(talkText.includes("组员的那句回答"), "talk.log 行为不变（人读稿照旧落，含 hops=1 头部）");
    assert.match(talkText, /hops=1/);
  });
});

// ── 2. 本机直连：一条自足记录，字段来自接线四处（reqId/model/via/hops/sessionKey/clientIp/echo） ──
test("接线 hops=0：落一条且 reqId/model/clientIp/sessionKey 在场，execute 结局不变", async () => {
  await withCapture(async () => {
    const { r, res } = await runPipeline({
      model: "wire/wmodel", talk: bucket({ reasoning: ["先想一想"], content: ["本机回答"], n: 9 }),
      handlerCtx: { reqId: "r-wire", hops: 0, sessionId: "ses_wire_head_value", clientIp: "203.0.113.9" },
    });
    assert.equal(r.handled, true, "捕获是旁路：结局不变");
    assert.equal(res.statusCode, 200);
    const rs = await rows("wire/wmodel");
    assert.equal(rs.length, 1);
    const row = rs[0];
    assert.equal(row.reqId, "r-wire");
    assert.equal(row.model, "wire/wmodel");
    assert.equal(row.via, "local");
    assert.equal(row.hops, 0);
    assert.equal(row.clientIp, "203.0.113.9", "handlerCtx.clientIp 一路传到位");
    assert.equal(row.sessionKey, norm("ses_wire_head_value"), "handlerCtx.sessionId 原值传进去、归一化在捕获模块内做");
    assert.equal(row.upstream, "api.wire.test", "echo 来自 upRes 回显头");
    assert.equal(row.account, "u9");
    assert.equal(row.status, 200);
    assert.equal(row.stream, 1);
    assert.equal(row.elapsedMs, 200);
    assert.equal(row.response.content, "本机回答", "out.detail.talk 原桶直接可读（没有被再剥一次）");
    assert.equal(row.response.reasoning, "先想一想");
    assert.equal(row.meta.cap, 2_000_000, "full 开时响应桶上限抬到 200 万（design D2 口径在场）");
    assert.equal(row.request.messages.length, 2, "请求侧全量：system 与 user 都在（不像 talk.log 只留最后一问）");
  });
});

// ── 3. spec「捕获失败不伤请求」：目录不可写 → 响应与关闭捕获时逐字一致 ──────────────────
test("接线 捕获目录不可写：execute 正常返回、响应字节与状态码与关闭捕获时逐字一致", async () => {
  await withCapture(async (dir) => {
    // 把 talk/full 占成一个已存在的普通文件 → 捕获侧 mkdir 必失败（Windows/POSIX 一致，不依赖 chmod 位）
    mkdirSync(join(dir, "talk"), { recursive: true });
    const blocker = join(dir, "talk", "full");
    writeFileSync(blocker, "占位：capture 的目录位被一个普通文件占了\n");
    const chunks = [SSE("甲"), SSE("乙"), "data: [DONE]\n\n"];
    const blocked = await runPipeline({
      model: "blk/model-a", talk: bucket({ content: ["被挡住的回答"], n: 6 }), chunks,
      handlerCtx: { reqId: "r-block", hops: 0, sessionId: "ses_blk", clientIp: "10.1.2.3" },
    });
    assert.equal(blocked.r.handled, true, "写盘失败不得改结局");
    assert.equal((await rows("blk/model-a")).length, 0, "没落盘就是没落盘（异常被吞）");
    assert.ok(statSync(blocker).isFile(), "占位文件还在：捕获没偷偷改路径或抛错");

    // 基线：同一份桩、同样输入，只是把 capture 关掉
    const prev = process.env.MSLXDFF_TALK_FULL;
    process.env.MSLXDFF_TALK_FULL = "0";
    let off;
    try {
      off = await runPipeline({
        model: "blk/model-b", talk: bucket({ content: ["被挡住的回答"], n: 6 }), chunks,
        handlerCtx: { reqId: "r-block", hops: 0, sessionId: "ses_blk", clientIp: "10.1.2.3" },
      });
    } finally {
      if (prev === undefined) delete process.env.MSLXDFF_TALK_FULL;
      else process.env.MSLXDFF_TALK_FULL = prev;
    }
    assert.deepEqual(blocked.res.wrote, off.res.wrote, "客户端收到的字节序列逐字一致");
    assert.equal(blocked.res.statusCode, off.res.statusCode, "状态码不变");
    assert.deepEqual(blocked.res.headers, off.res.headers, "响应头也不变");
    assert.deepEqual(blocked.events.map((e) => e.type), off.events.map((e) => e.type), "事件序列不变（闸门与判定没被旁路扰动）");
    assert.ok(existsSync(talkLogFile("blk/model-a")), "capture 挂了 talk.log 照旧落（生死独立）");
  });
});

// ── 4. spec「failover 两个候选各留一条」 ──────────────────────────────────────────────
test("接线 failover 两候选（A 空轮、B 成功）：语料两条、reqId 相同 model 不同", async () => {
  await withCapture(async () => {
    const a = await runPipeline({
      model: "fo/cand-a", emptyTurn: true, talk: bucket(), chunks: ['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'],
      handlerCtx: { reqId: "r-fo", hops: 0, sessionId: "ses_fo", clientIp: "127.0.0.1" },
    });
    const b = await runPipeline({
      model: "fo/cand-b", talk: bucket({ content: ["B 的回答"], n: 5 }), chunks: [SSE("B 的回答")],
      handlerCtx: { reqId: "r-fo", hops: 0, sessionId: "ses_fo", clientIp: "127.0.0.1" },
    });
    assert.equal(b.r.handled, true);
    const ra = await rows("fo/cand-a");
    const rb = await rows("fo/cand-b");
    assert.equal(ra.length, 1, "A 这轮即便空轮也留档（诊断要的正是这一轮）");
    assert.equal(rb.length, 1, "B 另成一条");
    assert.equal(ra[0].reqId, rb[0].reqId, "同一客户端请求");
    assert.notEqual(ra[0].model, rb[0].model, "两个候选模型分别是两条记录（分文件也各自自足）");
    assert.equal(ra[0].response.content, "");
    assert.equal(rb[0].response.content, "B 的回答");
    assert.deepEqual(a.res.wrote, ['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'], "A 那轮的响应字节原样写出（旁路没插手）");
  });
});

// ── 5. tasks 4.2：绕过 relay-pipeline 的两处收尾也接了线 ─────────────────────────────
function exhaustedCtx({ model, handlerCtx }) {
  const res = fakeRes();
  const events = [];
  const base = {
    res,
    body: { stream: true, messages: [{ role: "user", content: "耗尽前最后一问" }] },
    lastErr: { model, upstream: { status: 502, _t: null }, status: 502, message: "all failed" },
    order: [model],
    requested: model,
    useAuto: false,
    handlerCtx,
    evt: (type, data) => events.push({ type, data }),
    logCall: () => {}, mark: () => {}, perf0: 0, stages: [], done: () => {},
    deps: {
      relay: async () => ({
        status: 200, ttfMs: 5, totalMs: 90, aborted: false, interrupted: false,
        detail: { chars: 4, toolCalls: 0, exitReason: "normal", usage: null, talk: bucket({ content: ["收尾这一轮的回答"], n: 9 }) },
      }),
    },
  };
  return { base, res, events };
}

test("接线 exhausted 两处收尾：local-exhausted / local-final 各落一条，hops>0 仍不落", async () => {
  await withCapture(async () => {
    const a = exhaustedCtx({ model: "ex/m1", handlerCtx: { reqId: "r-exh-a", hops: 0, sessionId: "ses_exh", clientIp: "203.0.113.21" } });
    assert.equal(await handleExhaustedLocal(a.base), true, "收尾结局不变");
    const b = exhaustedCtx({ model: "ex/m2", handlerCtx: { reqId: "r-exh-b", hops: 0, sessionId: "ses_exh", clientIp: "203.0.113.22" } });
    assert.equal(await handleExhaustedAll(b.base), true);
    const peer = exhaustedCtx({ model: "ex/m3", handlerCtx: { reqId: "r-exh-c", hops: 2, sessionId: "ses_exh", clientIp: "198.51.100.9" } });
    assert.equal(await handleExhaustedAll(peer.base), true);
    await new Promise((r) => setTimeout(r, 50)); // 断言前排空（flushAgentLoop 亦可，这里连带把 talk.log 的同步写挤过去）
    const ra = await rows("ex/m1");
    const rb = await rows("ex/m2");
    assert.equal(ra.length, 1);
    assert.equal(ra[0].via, "local-exhausted");
    assert.equal(ra[0].reqId, "r-exh-a");
    assert.equal(ra[0].model, "ex/m1");
    assert.equal(ra[0].clientIp, "203.0.113.21");
    assert.equal(ra[0].response.content, "收尾这一轮的回答", "绕过 relay-pipeline 的最后一站也带 full 侧响应内容");
    assert.equal(rb.length, 1);
    assert.equal(rb[0].via, "local-final");
    assert.equal((await rows("ex/m3")).length, 0, "hops>0 在 exhausted 收尾同样不落（组员对话不进本机语料）");
    assert.ok(readFileSync(talkLogFile("ex/m3"), "utf8").includes("收尾这一轮的回答"), "而 talk.log 照旧落（生死独立）");
  });
});

// ── 6. 真实转发路径端到端：客户端头与 x-forwarded-for 一路到语料（chat-pipeline → relay → capture） ──
test("接线 端到端（createChatPipeline + 真 http）：clientIp 取 x-forwarded-for 首段、sessionKey 取会话头", async () => {
  await withCapture(async () => {
    const pipe = createChatPipeline({
      upstream: {
        chat: async () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "端到端回答" } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }), {
          status: 200, headers: { "content-type": "application/json", "x-mslxdff-upstream": "api.e2e.test" },
        }),
      },
      auto: null, logs: null, peers: null, groups: null, bus: null, token: "tok", plugins: [], maxHops: 3,
    });
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      req.body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      await pipe.execute({ req, res });
    });
    const text = await new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", async () => {
        try {
          const resp = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.77, 10.0.0.1", "x-session-id": "ses_e2e_head_value" },
            body: JSON.stringify({ model: "wire/e2emodel", messages: [{ role: "system", content: "E2E_SYSTEM" }, { role: "user", content: "端到端一问" }] }),
          });
          const t = await resp.text();
          assert.equal(resp.status, 200, "客户端状态码不变");
          resolve(t);
        } catch (e) { reject(e); } finally {
          await new Promise((r) => server.close(r));
        }
      });
    });
    assert.ok(text.includes("端到端回答"), "响应正文照旧透传");
    const rs = await rows("wire/e2emodel");
    assert.equal(rs.length, 1, "真实转发路径落了一条");
    const row = rs[0];
    assert.equal(row.model, "wire/e2emodel");
    assert.equal(row.hops, 0);
    assert.equal(row.clientIp, "203.0.113.77", "handlerCtx.clientIp = x-forwarded-for 首段（helpers.js 口径）");
    assert.equal(row.sessionKey, norm("ses_e2e_head_value"), "客户端会话头原值传进捕获、归一化在模块内");
    assert.equal(row.via, "local");
    assert.equal(row.upstream, "api.e2e.test");
    assert.equal(row.response.content, "端到端回答");
    assert.ok(row.reqId, "reqId 由 pipeline 生成并在场");
  });
});

// ── 7. 关停钩子：既有关停序列（startServer().close()）返回时语料已排空 ────────────────
test("关停 钩子排空写队列：srv.close() 返回后语料已完整落盘（不靠测试自己 flush）", async () => {
  await withCapture(async () => {
    const srv = startServer({ router: async () => {}, signals: false }, 0);
    await srv.ready();
    const big = "x".repeat(60_000);
    for (let i = 0; i < 20; i++) {
      recordAgentLoop({
        reqId: `shut${i}`, model: "shut/model", via: "local", hops: 0,
        body: { messages: [{ role: "user", content: big }] },
        out: { status: 200, totalMs: 1, detail: { talk: bucket({ content: ["收尾"], n: 2 }) } },
        sessionKey: "ses_shut", clientIp: "127.0.0.1",
      });
    }
    await srv.close(); // 关停序列里那次 flushAgentLoop 是唯一的排空点
    const rs = rawRows("shut/model"); // 刻意不再 await flushAgentLoop()
    assert.equal(rs.filter(Boolean).length, 20, "关停返回即语料完整（丢尾即钩子失效）");
  });
});

// —— §2.4 hedge 形态：out.totalMs 极小（缓冲重放）而 attemptStartMs 在数千毫秒前 ——
// 真钟锚点（performance.now，与 serial-trial/auto-race 创建点同款）：不再喂 perfNow 桩 + 自造起点，
// 否则桩钟与 Date.now 兜底同形，会把生产混钟（P0：elapsedMs=1791249258686）掩盖掉。
test("接线 hedge 尝试耗时：语料 elapsedMs=尝试墙钟（千毫秒量级）、meta.relayMs=relay 的极小计时", async () => {
  await withCapture(async () => {
    const res = fakeRes();
    // 尝试起点在 7207ms 前（真钟倒推）；假 relay 只报 totalMs=2（重放段）
    const { pipe } = makePipe({ talk: bucket({ content: ["重放的回答"], n: 5 }), chunks: [SSE("重放的回答")], totalMs: 2 });
    const r = await pipe.execute({
      res, upRes: upEchoRes(),
      body: { stream: true, messages: [{ role: "system", content: "hedge 的 system" }, { role: "user", content: "hedge 问题" }] },
      requested: "hedge/m1", actual: "hedge/m1", via: "local",
      handlerCtx: { reqId: "r-hedge", hops: 0, sessionId: "ses_hedge_head", clientIp: "127.0.0.1" },
      attemptStartMs: performance.now() - 7207,
    });
    assert.equal(r.handled, true, "读数修正仍是纯旁路");
    const [row] = await rows("hedge/m1");
    assert.ok(Number.isFinite(row.elapsedMs) && row.elapsedMs >= 7207 && row.elapsedMs <= 7207 + 60_000,
      `语料 elapsedMs 取本次尝试墙钟（真钟锚点 ≥7207ms，不再报 2ms），实得 ${row.elapsedMs}`);
    assert.equal(row.meta.relayMs, 2, "relay 内部计时另存 meta.relayMs（恒写）");
    const head = readFileSync(talkLogFile("hedge/m1"), "utf8").split("\n")[0];
    const hm = head.match(/elapsed=(\d+)ms/);
    assert.ok(hm && Number(hm[1]) >= 7207, `talk/*.log 头行 elapsed= 同取尝试墙钟（≥7207ms），实得 ${head}`);
    assert.match(head, /relayMs=2ms/, "头行另列 relayMs（两值不同才出现）");
  });
});

test("接线 普通尝试（未传 attemptStartMs）：elapsed 回退 totalMs 且与 relayMs 同值、头行不重复打 relayMs", async () => {
  await withCapture(async () => {
    const { r } = await runPipeline({
      model: "plain/m1", talk: bucket({ content: ["正常回答"], n: 4 }),
      handlerCtx: { reqId: "r-plain", hops: 0, sessionId: "ses_plain_head", clientIp: "127.0.0.1" },
    });
    assert.equal(r.handled, true);
    const [row] = await rows("plain/m1");
    assert.equal(row.elapsedMs, 200, "无尝试起点 → 回退 out.totalMs（与 relayMs 同值，spec 降级 scenario）");
    assert.equal(row.meta.relayMs, 200);
    const head = readFileSync(talkLogFile("plain/m1"), "utf8").split("\n")[0];
    assert.match(head, /elapsed=200ms/);
    assert.ok(!head.includes("relayMs="), "同值不打印（grill Q3）");
  });
});

// —— P0 防回归（真时钟混钟）：生产 5 个 handler 构造 createRelayPipeline 都不传 perfNow（relay-pipeline.js 的兜底曾是 Date.now，P1-A 后钉成 performance.now），
// 而 attemptStartMs 的全部创建点是 performance.now（serial-trial.js:51/97/225/234、auto-race.js:56）。
// 一旦落盘点改走可兜底 Date.now 的钟，elapsedMs 就变成 Date.now − performance.now ≈ 1.79e12 的 epoch 天文数字
//（实锤语料 elapsedMs=1791249258686）。本例刻意不传任何 perfNow 桩、attemptStartMs 用真钟，使混钟必红。
function realClockPipe(talk) {
  const state = { relayTotalMs: null };
  const pipe = createRelayPipeline({
    relay: async (res) => {
      const t0 = performance.now();
      await new Promise((r) => setTimeout(r, 20)); // 尝试真实耗时：relay 窗口 ⊆ 尝试窗口，且混钟差远大于任何上限容差
      state.relayTotalMs = Math.round(performance.now() - t0); // 与 stream.js:319 同款：relay 内部计时也在 performance.now 钟上
      res.statusCode = 200;
      res.write(SSE("真钟回答"));
      res.end();
      return {
        status: 200, ttfMs: 3, totalMs: state.relayTotalMs, aborted: false, interrupted: false, preflightMs: 0,
        detail: { chars: 4, toolCalls: 0, exitReason: "normal", chatShaped: false, sawFinishReason: "stop", wroteChunks: 1, stallHits: 0, maxGapMs: 0, usage: null, talk },
      };
    },
    buildFallbackInfo,
    auto: { recordOk: async () => {}, recordError: async () => {}, recordLatency: async () => {} },
    evt: () => {}, mark: () => {}, logCall: () => {}, logError: () => {}, // 关键：不传 perfNow（生产构造同款缺省）
  });
  return { pipe, state };
}

test("接线 真时钟防混钟回归：不传 perfNow 桩 + 真 attemptStartMs 时，落盘 elapsedMs 是本次尝试墙钟（0..60s 且 ≥ meta.relayMs），epoch 值进不来", async () => {
  await withCapture(async () => {
    const res = fakeRes();
    const { pipe } = realClockPipe(bucket({ content: ["真钟回答"], n: 4 }));
    const r = await pipe.execute({
      res, upRes: upEchoRes(),
      body: { stream: true, messages: [{ role: "system", content: "真钟 system" }, { role: "user", content: "真钟一问" }] },
      requested: "realclock/m1", actual: "realclock/m1", via: "local",
      handlerCtx: { reqId: "r-realclock", hops: 0, sessionId: "ses_rc_head", clientIp: "127.0.0.1" },
      attemptStartMs: performance.now(), // 生产同款真钟锚点（serial-trial tUp 口径）
    });
    assert.equal(r.handled, true, "时钟读数修正仍是纯旁路：结局不变");
    const [row] = await rows("realclock/m1");
    assert.ok(Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0 && row.elapsedMs <= 60_000,
      `语料 elapsedMs 必须是本次尝试墙钟（0..60_000ms），实得 ${row.elapsedMs} —— 若 ≈1.79e12 即 _perfNow 的 Date.now 兜底与 performance.now 锚点混钟复发`);
    assert.ok(row.elapsedMs >= row.meta.relayMs,
      `尝试墙钟 ≥ relay 内部计时（relay 窗口 ⊆ 尝试窗口），实得 elapsed=${row.elapsedMs} relayMs=${row.meta.relayMs}`);
    // talk/*.log 头行是同一 attemptMs 的第二个落盘点：同判据（防只修语料不修头行）
    const head = readFileSync(talkLogFile("realclock/m1"), "utf8").split("\n")[0];
    const hm = head.match(/elapsed=(\d+)ms/);
    assert.ok(hm && Number(hm[1]) <= 60_000, `talk 头行 elapsed= 同取本次尝试墙钟（≤60s），实得 ${head}`);
  });
});

test("接线 meta.relayMs 恒等于 relay 内部 totalMs（真时钟、不传 perfNow 桩）：elapsed 与 relayMs 分列各是真值", async () => {
  await withCapture(async () => {
    const res = fakeRes();
    const { pipe, state } = realClockPipe(bucket({ content: ["分列回答"], n: 4 }));
    const r = await pipe.execute({
      res, upRes: upEchoRes(),
      body: { stream: true, messages: [{ role: "user", content: "分列一问" }] },
      requested: "relayed/m1", actual: "relayed/m1", via: "local",
      handlerCtx: { reqId: "r-relayed", hops: 0, sessionId: "ses_rl_head", clientIp: "127.0.0.1" },
      attemptStartMs: performance.now(),
    });
    assert.equal(r.handled, true);
    assert.ok(Number.isFinite(state.relayTotalMs) && state.relayTotalMs >= 15, "前置条件：假 relay 真的计时在场（totalMs 与 stream.js 同口径产出）");
    const [row] = await rows("relayed/m1");
    assert.equal(row.meta.relayMs, state.relayTotalMs, "meta.relayMs === relay 内部 totalMs（恒写、逐值原样，design D3 分列口径）");
  });
});

// —— P1-A 防回归（同型混钟残留）：client-abort 事件的 totalMs 用 _perfNow() − perf0，
// 而 perf0 出自 chat-pipeline/index.js:21 的 performance.now()，且全 src 已核实无任何生产调用方传 perfNow
//（只有测试传桩）→ :58 兜底曾是 Date.now，一相减 events.log 里 client-abort.totalMs ≈ 1.79e12 的 epoch 假值。
// 本例不传任何 perfNow 桩（生产 5 个 handler 构造同款缺省）；perf0 用真钟；由 relay 桩在下游 close 时回调
// onDownstreamAbort（stream.js:142 res.on("close") 同款时机），走的是管线自己注册的那条回调（被修的行就在里面）。
function abortClockPipe() {
  const events = [];
  const pipe = createRelayPipeline({
    relay: async (res, _upRes, _body, opts) => {
      const t0 = performance.now();
      await new Promise((r) => setTimeout(r, 20)); // 真实窗口：任何混钟差（≈1.79e12）都远大于这个量级
      res.statusCode = 200;
      res.write(SSE("客户端先跑了"));
      res.end();
      opts.onDownstreamAbort?.(); // 生产里由 stream.js onClose 在 finishedNormally=false 时触发
      return {
        status: 200, ttfMs: 3, totalMs: Math.round(performance.now() - t0), aborted: true, interrupted: false, preflightMs: 0,
        detail: { chars: 7, toolCalls: 0, exitReason: "normal", chatShaped: false, sawFinishReason: "stop", wroteChunks: 1, stallHits: 0, maxGapMs: 0, usage: null, talk: bucket({ content: ["客户端先跑了"], n: 7 }) },
      };
    },
    buildFallbackInfo,
    auto: { recordOk: async () => {}, recordError: async () => {}, recordLatency: async () => {} },
    evt: (type, data) => events.push({ type, data }),
    mark: () => {}, logCall: () => {}, logError: () => {}, // 关键：不传 perfNow（生产构造同款缺省）
  });
  return { pipe, events };
}

test("接线 client-abort 同钟防回归：不传 perfNow 桩时事件 totalMs 是 0..60s 的墙钟读数，epoch 量级进不来", async () => {
  await withCapture(async () => {
    const res = fakeRes();
    const { pipe, events } = abortClockPipe();
    const r = await pipe.execute({
      res, upRes: upEchoRes(),
      body: { stream: true, messages: [{ role: "user", content: "半途走掉的一问" }] },
      requested: "abort/m1", actual: "abort/m1", via: "local",
      handlerCtx: { reqId: "r-abort", hops: 0, sessionId: "ses_abort_head", clientIp: "127.0.0.1" },
      perf0: performance.now(), // 生产同款锚点（chat-pipeline/index.js:21 的 performance.now()）
      stages: [],
    });
    assert.equal(r.handled, true, "修钟是纯读数修正：结局不变");
    const ab = events.find((e) => e.type === "client-abort");
    assert.ok(ab, "client-abort 事件必须由下游断开路径发出");
    const t = ab.data.totalMs;
    assert.ok(Number.isFinite(t) && t >= 0 && t <= 60_000,
      `client-abort.totalMs 必须是与 perf0 同钟的墙钟（0..60_000ms），实得 ${t} —— 若 ≈1.79e12 即 _perfNow 兜底 Date.now 与 performance.now 锚点混钟复发`);
    assert.ok(t >= 20, `前置条件：假 relay 真的等过 20ms（读数不是恒 0），实得 ${t}`);
  });
});
