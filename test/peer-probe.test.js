// hi 探针契约（用户 2026-10-20）：某个节点当备选时打一个 hi，轮到它时再打一个 hi；
// hi 回不来（4xx/5xx）就当这个备选不行，直接换下一个。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serialTryPeers } from "../src/routes/peer-serial.js";

const MODEL = "deepseek-v4-flash-free";

function tmpFile() {
  return join(mkdtempSync(join(tmpdir(), "peer-probe-")), "state.json");
}

/** 假组员：记录收到的请求；probeStatus 决定 hi 返回什么，chatStatus 决定真实转发返回什么。 */
async function fakePeer(name, { probeStatus = 200, chatStatus = 200 } = {}) {
  const hits = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const isProbe = req.headers["x-mslxdff-probe"] === "1";
      hits.push({ name, probe: isProbe });
      const status = isProbe ? probeStatus : chatStatus;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status < 400 ? { ok: true } : { error: { type: "FreeUsageLimitError" } }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  return { name, url, hits, close: () => srv.close() };
}

function makeCtx(peers, events) {
  const record = { errors: [], results: [] };
  return {
    ctx: {
      reqId: "t",
      model: MODEL,
      body: { model: MODEL, messages: [{ role: "user", content: "x" }] },
      hops: 0,
      peers: {
        recordError: async (url, e) => { record.errors.push({ url, ...e }); },
        recordResult: async (url, r) => { record.results.push({ url, ...r }); },
        stat: () => null,
        isHot: () => false,
      },
      plugins: [],
      evt: (type, data) => events.push({ type, ...data }),
      peerErrors: [],
      triedUrls: new Set(),
    },
    record,
  };
}

function deps({ peers, probe }) {
  return {
    resolvePeerTarget: async (ctx, p) => ({ peer: p, target: ctx.model }),
    // 真实发一次 HTTP：让 fakePeer 的 hits 记录得到「真实转发」（不是探针）
    forwardToPeer: async (p, body, target) => {
      const res = await fetch(`${p.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: target }),
      });
      return res;
    },
    peerName: (p) => p.name,
    recordLater: () => {},
    summarizeRequest: () => null,
    runHook: async () => {},
    errMsg: (e) => String(e?.message || e),
    perAttemptCap: 5_000,
    deadline: 0,
    budgetMs: 0,
    probePeer: probe,
  };
}

test("备选打 hi、轮到再打 hi：hi 失败的节点被跳过，不打真实转发", async () => {
  const dead = await fakePeer("dead", { probeStatus: 429 });
  const alive = await fakePeer("alive", { probeStatus: 200 });
  const events = [];
  const { ctx } = makeCtx([], events);
  const candidates = [
    { name: "dead", url: dead.url, token: "t" },
    { name: "alive", url: alive.url, token: "t" },
  ];
  const probe = async (peer) => {
    // 走真 HTTP：让 fakePeer 的 hits 记录得到
    const res = await fetch(`${peer.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "x-mslxdff-probe": "1", "Content-Type": "application/json" },
      body: "{}",
    });
    return { ok: res.status < 400, status: res.status, ms: 1 };
  };
  const win = await serialTryPeers({
    candidates, v6Candidates: [], ctx, tried: new Set(),
    deps: deps({ peers: candidates, probe }),
  });
  try {
    assert.equal(win?.peer?.name, "alive", "胜者应是活节点");
    assert.equal(dead.hits.filter((h) => !h.probe).length, 0, "死节点的 hi 已判死 ⇒ 不该再收到真实转发");
    assert.ok(dead.hits.filter((h) => h.probe).length >= 1, "死节点至少该被 hi 问过");
    assert.equal(alive.hits.filter((h) => !h.probe).length, 1, "活节点收到一次真实转发");
    const skips = events.filter((e) => e.type === "peer-probe" && e.action === "skip");
    assert.equal(skips.length, 1, "应有一条「跳过」探针事件");
    assert.equal(skips[0].status, 429);
  } finally {
    dead.close(); alive.close();
  }
});

test("hi 连不上（超时/拒连）不算判死：仍照常转发，由 forwardToPeer 记账", async () => {
  const alive = await fakePeer("alive", { probeStatus: 200 });
  const events = [];
  const { ctx } = makeCtx([], events);
  const candidates = [{ name: "alive", url: alive.url, token: "t" }];
  // 探针一律「未知」（连不上）——不该因此跳过节点
  const probe = async () => ({ ok: true, status: 0, unknown: true });
  const win = await serialTryPeers({
    candidates, v6Candidates: [], ctx, tried: new Set(),
    deps: deps({ peers: candidates, probe }),
  });
  try {
    assert.equal(win?.peer?.name, "alive", "探针未知时必须照常试，不许错杀");
    assert.equal(alive.hits.filter((h) => !h.probe).length, 1, "真实转发照常发生");
  } finally { alive.close(); }
});

test("没注入 probePeer 时行为不变（可安全关掉探针）", async () => {
  const alive = await fakePeer("alive", { probeStatus: 200 });
  const events = [];
  const { ctx } = makeCtx([], events);
  const candidates = [{ name: "alive", url: alive.url, token: "t" }];
  const d = deps({ peers: candidates, probe: undefined });
  delete d.probePeer;
  const win = await serialTryPeers({ candidates, v6Candidates: [], ctx, tried: new Set(), deps: d });
  try {
    assert.equal(win?.peer?.name, "alive");
    assert.equal(alive.hits.filter((h) => h.probe).length, 0, "无 probePeer 就不该有 hi 请求");
    assert.equal(events.filter((e) => e.type === "peer-probe").length, 0);
  } finally { alive.close(); }
});
