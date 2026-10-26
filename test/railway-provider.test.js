// railway 定制供应商：opencode zen free 层的另一个 IP 出口。
// 关键契约：① 只列 free 模型；② 请求强制补 free-lane 形状（否则 403 FreeTierError）；
//          ③ 非流式请求也要转成「上游 stream + 本地聚合」。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRailwayProvider, isFreeModelId, filterFreeModels } from "../src/providers/railway.js";

const SSE = [
  { id: "c1", object: "chat.completion.chunk", model: "deepseek-v4.1-flash-free", choices: [{ index: 0, delta: { role: "assistant", content: "PONG" } }] },
  { id: "c1", object: "chat.completion.chunk", model: "deepseek-v4.1-flash-free", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
];

// 模拟 railway：校验 free-lane 形状，不合格回 403 FreeTierError（复刻上游真实行为）
function railwayStub() {
  const seen = [];
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const url = (req.url || "").split("?")[0];
      if (req.method === "GET" && url === "/zen/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          object: "list",
          data: [
            { id: "deepseek-v4.1-flash-free", object: "model", owned_by: "opencode" },
            { id: "glm-5.3-flash-free", object: "model", owned_by: "opencode" },
            { id: "big-pickle", object: "model", owned_by: "opencode" },
            { id: "claude-sonnet-5", object: "model", owned_by: "opencode" },  // 付费，必须被过滤
            { id: "gpt-5.4", object: "model", owned_by: "opencode" },           // 付费
          ],
        }));
        return;
      }
      if (req.method === "POST" && url === "/zen/v1/chat/completions") {
        let body = {};
        try { body = JSON.parse(raw); } catch {}
        seen.push({ body, headers: req.headers });
        const tools = (body.tools || []).map((t) => t?.function?.name);
        const core = ["bash", "edit", "glob", "grep", "read"];
        const okShape = body.stream === true && core.every((n) => tools.includes(n));
        const okIdentity = Boolean(req.headers["x-opencode-session"] && req.headers["x-opencode-client"]);
        if (!okShape || !okIdentity) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "FreeTierError", message: "free tier only" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(SSE.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n");
        return;
      }
      res.writeHead(404); res.end("{}");
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({
    url: `http://127.0.0.1:${srv.address().port}`,
    seen,
    close: () => new Promise((x) => srv.close(x)),
  })));
}

describe("railway：free 模型判定", () => {
  test("-free 后缀即 free", () => {
    assert.equal(isFreeModelId("deepseek-v4.1-flash-free"), true);
    assert.equal(isFreeModelId("mimo-v2.6-flash-free"), true);
  });
  test("无后缀的付费模型不是 free", () => {
    assert.equal(isFreeModelId("claude-sonnet-5"), false);
    assert.equal(isFreeModelId("gpt-5.4"), false);
    assert.equal(isFreeModelId("glm-5.3"), false);
  });
  test("已知免费档无后缀模型也算 free（big-pickle / beam）", () => {
    assert.equal(isFreeModelId("big-pickle"), true);
    assert.equal(isFreeModelId("beam"), true);
  });
  test("过滤整张表只留 free", () => {
    const out = filterFreeModels([
      { id: "a-free" }, { id: "claude-opus-5" }, { id: "big-pickle" }, { id: "gpt-6-sol" },
    ]);
    assert.deepEqual(out.map((m) => m.id), ["a-free", "big-pickle"]);
  });
});

describe("railway：工厂行为", () => {
  let srv, dir, savedEnv;
  const setup = async () => {
    srv = await railwayStub();
    dir = mkdtempSync(join(tmpdir(), "railway-"));
    savedEnv = process.env.MSLXDFF_STATE_FILE;
    process.env.MSLXDFF_STATE_FILE = join(dir, "state.json");
  };
  const teardown = async () => {
    process.env.MSLXDFF_STATE_FILE = savedEnv;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    await srv.close();
  };

  test("listModels 只返回 free 模型（付费的被滤掉），且带 railway/ 前缀", async () => {
    await setup();
    try {
      const p = createRailwayProvider({ baseUrl: [srv.url] });
      const list = await p.listModels();
      const ids = list.map((m) => m.id);
      assert.deepEqual(ids.sort(), [
        "railway/big-pickle",
        "railway/deepseek-v4.1-flash-free",
        "railway/glm-5.3-flash-free",
      ]);
      await p.close();
    } finally { await teardown(); }
  });

  test("非流式请求：自动补 free-lane 形状（stream+五工具）+ 身份头，上游 200 并聚合回 JSON", async () => {
    await setup();
    try {
      const p = createRailwayProvider({ baseUrl: [srv.url] });
      const res = await p.chat({
        model: "deepseek-v4.1-flash-free",
        stream: false,                              // 客户端要非流式
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(res.status, 200, "补形状后应通过 free-lane 门禁");
      const json = await res.json();
      assert.equal(json.object, "chat.completion");
      assert.equal(json.choices[0].message.content, "PONG");

      const sent = srv.seen.at(-1);
      assert.equal(sent.body.stream, true, "上游必须收到 stream:true");
      const names = sent.body.tools.map((t) => t.function.name);
      for (const n of ["bash", "edit", "glob", "grep", "read"]) assert.ok(names.includes(n), `缺核心工具 ${n}`);
      assert.ok(sent.headers["x-opencode-session"], "必须带 opencode session 身份头");
      await p.close();
    } finally { await teardown(); }
  });

  test("流式请求：原样返回 SSE，不聚合", async () => {
    await setup();
    try {
      const p = createRailwayProvider({ baseUrl: [srv.url] });
      const res = await p.chat({
        model: "deepseek-v4.1-flash-free",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") || "", /event-stream/);
      const txt = await res.text();
      assert.match(txt, /data: .*PONG/);
      await p.close();
    } finally { await teardown(); }
  });

  test("调用方已带核心工具时不重复注入", async () => {
    await setup();
    try {
      const p = createRailwayProvider({ baseUrl: [srv.url] });
      const tools = ["bash", "edit", "glob", "grep", "read"].map((n) => ({
        type: "function", function: { name: n, parameters: { type: "object", properties: {} } },
      }));
      const res = await p.chat({
        model: "deepseek-v4.1-flash-free", stream: false, tools,
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(res.status, 200);
      const sent = srv.seen.at(-1);
      assert.equal(sent.body.tools.length, 5, "不该重复注入已有的五个工具");
      await p.close();
    } finally { await teardown(); }
  });

  // 客户端透传的 x-session-id 是任意串（不是 opencode id 形状）。裸拼 `ses_` + 该串会产出
  // 不合规 id：上游会反解低 12 位校验 counter，形状不符即 403 FreeTierError。
  test("客户端透传任意会话串：派生出的 session 头必须合规（不可裸拼 ses_）", async () => {
    await setup();
    try {
      const p = createRailwayProvider({ baseUrl: [srv.url] });
      const clientId = "b7f3c1a0-9d2e-4f11-8a3b-client-side-affinity-id";
      const send = () => p.chat(
        { model: "deepseek-v4.1-flash-free", stream: true, messages: [{ role: "user", content: "hi" }] },
        { sessionId: clientId },
      );
      assert.equal((await send()).status, 200);
      const sess = srv.seen.at(-1).headers["x-opencode-session"];
      assert.match(sess, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/, `session 形状不合规: ${sess}`);
      const counter = Number((~BigInt("0x" + sess.slice(4, 16))) & 0xfffn);
      assert.ok(counter >= 0 && counter <= 63, `counter 越界: ${counter}`);

      // 同一客户端会话串必须派生出同一 session（会话亲和 / 上游按 session 归组额度）
      await send();
      assert.equal(srv.seen.at(-1).headers["x-opencode-session"], sess, "同一会话串应稳定派生");
      await p.close();
    } finally { await teardown(); }
  });

  test("已合规的 ses_ 会话 id 原样透传", async () => {
    await setup();
    try {
      const good = "ses_0123456789abABCDEFghijklmn";
      const p = createRailwayProvider({ baseUrl: [srv.url] });
      await p.chat(
        { model: "deepseek-v4.1-flash-free", stream: true, messages: [{ role: "user", content: "hi" }] },
        { sessionId: good },
      );
      assert.equal(srv.seen.at(-1).headers["x-opencode-session"], good);
      await p.close();
    } finally { await teardown(); }
  });
});

// ── 多出口：同一供应商的多个反代端点（免费额度按出口 IP 计）────────────────────
// 顺序=优先级：缺省「新隧道 → 原 railway」；前一个用完/挂掉才轮到下一个。
function multiStub(handler, trace = [], tag = "?") {
  const seen = [];
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const url = (req.url || "").split("?")[0];
      seen.push({ url, method: req.method }); trace.push({ tag, method: req.method });
      let out;
      if (req.method === "GET" && url === "/zen/v1/models") {
        out = handler({ kind: "models" }) || { status: 200 };
        res.writeHead(out.status, { "Content-Type": "application/json" });
        res.end(out.body ?? JSON.stringify({ object: "list", data: [] }));
        return;
      }
      if (req.method === "POST" && url === "/zen/v1/chat/completions") {
        let body = {};
        try { body = JSON.parse(raw); } catch {}
        out = handler({ kind: "chat", body, headers: req.headers }) || { status: 200, sse: true };
        if (out.sse) {
          res.writeHead(out.status ?? 200, { "Content-Type": "text/event-stream" });
          res.end(SSE.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n");
          return;
        }
        res.writeHead(out.status, { "Content-Type": "application/json" });
        res.end(out.body ?? "{}");
        return;
      }
      res.writeHead(404); res.end("{}");
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({
    url: `http://127.0.0.1:${srv.address().port}`,
    seen,
    posts: () => seen.filter((s) => s.method === "POST").length,
    gets: () => seen.filter((s) => s.method === "GET").length,
    close: () => new Promise((x) => srv.close(x)),
  })));
}

describe("railway：多出口顺序与回落", () => {
  const INSTABOX = "https://3000-agqxlhk7jgtegt4n5acnqyrndi.instabox.tech/ai-api";
  const LEGACY = "https://mytestip-production.up.railway.app/ai-api";
  let a, b, dir, savedEnv, trace = [];
  const setup = async (aHandler, bHandler) => {
    trace = []; a = await multiStub(aHandler, trace, "A"); b = await multiStub(bHandler, trace, "B");
    dir = mkdtempSync(join(tmpdir(), "railway-multi-"));
    savedEnv = process.env.MSLXDFF_STATE_FILE;
    process.env.MSLXDFF_STATE_FILE = join(dir, "state.json");
  };
  const teardown = async () => {
    process.env.MSLXDFF_STATE_FILE = savedEnv;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    await a.close(); await b.close();
  };
  const send = (p) => p.chat({ model: "deepseek-v4.1-flash-free", stream: true, messages: [{ role: "user", content: "hi" }] });

  test("缺省出口顺序：新隧道优先、原 railway 兜底", () => {
    const savedBasesEnv = process.env.MSLXDFF_RAILWAY_BASES;
    delete process.env.MSLXDFF_RAILWAY_BASES;
    try {
      const p = createRailwayProvider({});
      assert.deepEqual(p.bases, [INSTABOX, LEGACY]);
      assert.equal(p.baseUrl, INSTABOX);
      assert.deepEqual(p.orderBases(), [INSTABOX, LEGACY]);
    } finally {
      if (savedBasesEnv === undefined) delete process.env.MSLXDFF_RAILWAY_BASES;
      else process.env.MSLXDFF_RAILWAY_BASES = savedBasesEnv;
    }
  });

  test("第一出口 429（额度耗尽）→ 自动落第二出口，客户端拿到 200", async () => {
    await setup(
      () => ({ status: 429, body: JSON.stringify({ error: { type: "FreeUsageLimitError" } }) }),
      () => ({ status: 200, sse: true }),
    );
    try {
      const p = createRailwayProvider({ baseUrl: [a.url, b.url], endpointRetryDelayMs: 0 });
      const res = await send(p);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /PONG/);
      assert.equal(a.posts(), 1);
      assert.equal(b.posts(), 1);
      await p.close();
    } finally { await teardown(); }
  });

  test("第一出口 5xx → 也落第二出口", async () => {
    await setup(() => ({ status: 503, body: "{}" }), () => ({ status: 200, sse: true }));
    try {
      const p = createRailwayProvider({ baseUrl: [a.url, b.url], endpointRetryDelayMs: 0 });
      assert.equal((await send(p)).status, 200);
      assert.equal(a.posts(), 1);
      assert.equal(b.posts(), 1);
      await p.close();
    } finally { await teardown(); }
  });

  test("第一出口 400（参数/身份类）→ 不换出口，原样交回", async () => {
    await setup(() => ({ status: 400, body: JSON.stringify({ error: { message: "bad request" } }) }), () => ({ status: 200, sse: true }));
    try {
      const p = createRailwayProvider({ baseUrl: [a.url, b.url], endpointRetryDelayMs: 0 });
      const res = await send(p);
      assert.equal(res.status, 400, "400 不该被当额度耗尽而换出口");
      assert.equal(b.posts(), 0, "第二出口不该被打");
      await p.close();
    } finally { await teardown(); }
  });

  test("用尽的出口进冷却：下一次请求直接打第二出口（不再白撞一发）", async () => {
    await setup(() => ({ status: 429, body: "{}" }), () => ({ status: 200, sse: true }));
    try {
      const p = createRailwayProvider({ baseUrl: [a.url, b.url], endpointCooldownMs: 60_000, endpointRetryDelayMs: 0 });
      assert.equal((await send(p)).status, 200);
      assert.equal(a.posts(), 1);
      assert.ok(p.endpointCooldownUntil(a.url) > Date.now(), "第一出口应处于冷却");
      assert.deepEqual(p.orderBases(), [b.url, a.url], "冷却后顺序下沉");
      assert.equal((await send(p)).status, 200);
      assert.equal(a.posts(), 1, "冷却期内不该再撞第一出口");
      assert.equal(b.posts(), 2);
      await p.close();
    } finally { await teardown(); }
  });

  test("只剩一个出口且 429 → 原样交回该 429（不假装成功）", async () => {
    await setup(() => ({ status: 429, body: "{}" }), () => ({ status: 200, sse: true }));
    try {
      const p = createRailwayProvider({ baseUrl: [a.url], endpointRetryDelayMs: 0 });
      assert.equal((await send(p)).status, 429);
      assert.equal(b.posts(), 0);
      await p.close();
    } finally { await teardown(); }
  });

  test("listModels：第一出口失败 → 用第二出口的目录（仍只留 free）", async () => {
    await setup(
      ({ kind }) => (kind === "models" ? { status: 500, body: "{}" } : { status: 200, sse: true }),
      ({ kind }) => (kind === "models"
        ? { status: 200, body: JSON.stringify({ object: "list", data: [{ id: "glm-5.3-flash-free", object: "model" }, { id: "gpt-5.4", object: "model" }] }) }
        : { status: 200, sse: true }),
    );
    try {
      const p = createRailwayProvider({ baseUrl: [a.url, b.url], endpointRetryDelayMs: 0 });
      assert.deepEqual((await p.listModels()).map((m) => m.id), ["railway/glm-5.3-flash-free"]);
      assert.equal(a.gets(), 1);
      assert.equal(b.gets(), 1);
      await p.close();
    } finally { await teardown(); }
  });

  test("出口列表解析：显式数组完整替换 / 非缺省单值排第一 / 缺省值不改优先级 / env 覆盖", async () => {
    const { resolveRailwayBases } = await import("../src/providers/railway-endpoints.js");
    assert.deepEqual(resolveRailwayBases({ baseUrl: ["http://x"], env: {} }), ["http://x"]);
    assert.deepEqual(resolveRailwayBases({ baseUrl: "http://x/", env: {} }), ["http://x", INSTABOX, LEGACY]);
    assert.deepEqual(resolveRailwayBases({ baseUrl: LEGACY, env: {} }), [INSTABOX, LEGACY]);
    assert.deepEqual(resolveRailwayBases({ env: { MSLXDFF_RAILWAY_BASES: "http://a, http://b ,http://a" } }), ["http://a", "http://b"]);
  });
});

// ── 失败分档与轮流重试（2026-10-25 用户改判）────────────────────────────────
// 429 → 该出口歇 1 小时（本请求内出局，换另一个不等待）；其它（5xx/连不上/超时）→ 等一会换另一个 URL，
// 两侧轮流、每出口最多 2 次；400/401/403 原样交回。
describe("railway：失败分档与轮流重试", () => {
  let a, b, dir, savedEnv, trace = [];
  const setup = async (aHandler, bHandler) => {
    trace = [];
    a = await multiStub(aHandler, trace, "A"); b = await multiStub(bHandler, trace, "B");
    dir = mkdtempSync(join(tmpdir(), "railway-rotate-"));
    savedEnv = process.env.MSLXDFF_STATE_FILE;
    process.env.MSLXDFF_STATE_FILE = join(dir, "state.json");
  };
  const teardown = async () => {
    process.env.MSLXDFF_STATE_FILE = savedEnv;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    await a.close(); await b.close();
  };
  const send = (p) => p.chat({ model: "deepseek-v4.1-flash-free", stream: true, messages: [{ role: "user", content: "hi" }] });

  test("429 → 该出口长冷却约 1 小时；本请求立即换另一个（不等待）", async () => {
    await setup(() => ({ status: 429, body: "{}" }), () => ({ status: 200, sse: true }));
    try {
      const p = createRailwayProvider({ baseUrl: [a.url, b.url], endpointRetryDelayMs: 0 });
      const t0 = Date.now();
      assert.equal((await send(p)).status, 200);
      assert.ok(Date.now() - t0 < 1_000, "429 换出口不该等待");
      const left = p.endpointCooldownUntil(a.url) - Date.now();
      assert.ok(left > 3_000_000, `429 出口应长冷却≈1h，实际 ${left}ms`);
      assert.equal(a.posts(), 1);
      assert.equal(b.posts(), 1);
      assert.deepEqual(p.orderBases(), [b.url, a.url], "长冷却后该出口沉底");
      await p.close();
    } finally { await teardown(); }
  });

  test("两个出口都 5xx → 轮流 A→B→A→B（每出口 2 次）后交回最后一条错误", async () => {
    await setup(() => ({ status: 503, body: "{}" }), () => ({ status: 503, body: "{}" }));
    try {
      const p = createRailwayProvider({ baseUrl: [a.url, b.url], endpointRetryDelayMs: 0 });
      assert.equal((await send(p)).status, 503);
      assert.equal(a.posts(), 2);
      assert.equal(b.posts(), 2);
      assert.deepEqual(trace.map((t) => t.tag), ["A", "B", "A", "B"], "两侧轮流");
      await p.close();
    } finally { await teardown(); }
  });

  test("429 的出口本请求内出局：另一个出口仍可试满 2 次", async () => {
    await setup(() => ({ status: 429, body: "{}" }), () => ({ status: 503, body: "{}" }));
    try {
      const p = createRailwayProvider({ baseUrl: [a.url, b.url], endpointRetryDelayMs: 0 });
      assert.equal((await send(p)).status, 503);
      assert.equal(a.posts(), 1, "429 后不再试它");
      assert.equal(b.posts(), 2);
      assert.deepEqual(trace.map((t) => t.tag), ["A", "B", "B"]);
      await p.close();
    } finally { await teardown(); }
  });

  test("其它失败确实「等一会」再换 URL（把 3s 档缩到 150ms 实测）", async () => {
    await setup(() => ({ status: 503, body: "{}" }), () => ({ status: 503, body: "{}" }));
    try {
      const p = createRailwayProvider({ baseUrl: [a.url, b.url], endpointRetryDelayMs: 150, endpointRounds: 1 });
      const t0 = Date.now();
      assert.equal((await send(p)).status, 503);
      const elapsed = Date.now() - t0;
      assert.ok(elapsed >= 140, `换出口前应等待约 150ms，实际 ${elapsed}ms`);
      assert.equal(a.posts(), 1);
      assert.equal(b.posts(), 1);
      await p.close();
    } finally { await teardown(); }
  });
});
