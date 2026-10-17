// v6pool 离线测试（三）：probe / index / report —— 零网络（探活 fetch 注入）、不改网卡。
import { test } from "node:test";
import assert from "node:assert/strict";

import { probeFrom } from "../src/v6pool/probe.js";
import { createPreferredDispatcher, createV6Pool } from "../src/v6pool/index.js";
import { inPrefix, parseV6 } from "../src/v6pool/prefix.js";
import { fmtConfig, fmtCounts, fmtDetect, fmtFirstOk, fmtPool, fmtPoolEmpty, fmtProbe, fmtSkip, fmtSwap } from "../src/v6pool/report.js";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
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
function fakeClaimer() {
  const ensured = [];
  const released = [];
  return {
    ensured,
    released,
    ensure: async (a) => {
      ensured.push(a);
      return a;
    },
    release: async (a) => {
      released.push(a);
      return true;
    },
    releaseAll: async () => [],
    releaseAllSync: () => [],
    sweepStale: async () => ({ removed: [], failed: [] }),
    claimed: () => ensured.filter((a) => !released.includes(a)),
  };
}
const POOL_ADDR = "2403:71c0:2000:114a::";
const DETECT_OK = () => ({
  ok: true,
  addr: parseV6(POOL_ADDR),
  bits: 64,
  iface: "eth0",
  hostBits: 64,
  mode: "add",
  source: "proc",
  prefix: "2403:71c0:2000:114a::/64",
  mine: ["2403:71c0:2000:114a::a"],
});

// ---------- probe ----------

test("probe：用池里的源地址打上游，拿到状态即判活，Agent 用完即关", async () => {
  const made = [];
  let seen = null;
  const agentFactory = (a) => {
    const x = captureAgent(a);
    made.push(x);
    return x;
  };
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, text: async () => "{}" };
  };
  const r = await probeFrom({ addr: "2403::b1", baseUrl: "https://opencode.ai/", path: "/zen/v1/models", agentFactory, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(made[0].box.name, "2403::b1", "必须用池里的源地址建 Agent");
  assert.equal(seen.init.dispatcher, made[0]);
  assert.equal(seen.url, "https://opencode.ai/zen/v1/models", "baseUrl 末尾斜杠要归一");
  assert.equal(made[0].box.closed, 1, "探活用的 Agent 必须关掉（否则每次探活漏一个连接池）");
});

test("probe：连不上/超时 ⇒ ok:false 且带错误原文（不许只剩「失败了」）", async () => {
  const agentFactory = () => captureAgent("x");
  const r = await probeFrom({
    addr: "2403::b1",
    agentFactory,
    fetchImpl: async () => {
      throw new Error("connect ECONNREFUSED 2606:4700::1:443");
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 0);
  assert.match(r.error, /ECONNREFUSED/);
});

// ---------- index：装配 ----------

test("index：检测不过 ⇒ 返回 null（行为与今天完全一致）且日志给具体原因与下一步", () => {
  const lines = [];
  const pool = createV6Pool({
    env: {},
    log: (l) => lines.push(l),
    deps: { detect: () => ({ ok: false, reason: "本机没有任何全局 IPv6 地址（只有 link-local / loopback）", hint: "确认网卡上启用了 IPv6" }), exitHook: false },
  });
  assert.equal(pool, null);
  assert.equal(lines.length, 2, "一行配置快照 + 一行跳过原因");
  assert.match(lines[1], /不启用/);
  assert.match(lines[1], /没有任何全局 IPv6 地址/);
  assert.match(lines[1], /下一步/);
});

test("index：总开关关掉 ⇒ 返回 null 且只打一行（不检测、不碰任何东西）", () => {
  const lines = [];
  const pool = createV6Pool({ env: { MSLXDFF_V6_POOL: "0" }, log: (l) => lines.push(l), deps: { exitHook: false } });
  assert.equal(pool, null);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /关着/);
});

test("index：有池 ⇒ 认领 count 个地址、逐个探活、只把探通的装进池（且避开本机自己的地址）", async () => {
  const lines = [];
  const claimer = fakeClaimer();
  const probed = [];
  const pool = createV6Pool({
    env: { MSLXDFF_V6_COUNT: "2" },
    log: (l) => lines.push(l),
    deps: {
      detect: DETECT_OK,
      claimer: () => claimer,
      probe: async ({ addr }) => {
        probed.push(addr);
        return { ok: true, status: 200, ms: 5 };
      },
      agentFactory: (a) => captureAgent(a),
      exitHook: false,
    },
  });
  assert.ok(pool, "有池必须建起来");
  await pool.ready;
  assert.equal(claimer.ensured.length, 2, "按 count 认领");
  assert.equal(probed.length, 2, "每个地址都要实证探活");
  assert.equal(pool.dispatcher.size, 2);
  const addrs = pool.dispatcher.entries().map((e) => e.addr);
  assert.equal(new Set(addrs).size, 2, "两个槽的地址必须不同");
  for (const a of addrs) {
    assert.ok(inPrefix(parseV6(a), { addr: parseV6(POOL_ADDR), bits: 64 }), `必须落池前缀内：${a}`);
    assert.notEqual(a, "2403:71c0:2000:114a::a", "不许拿本机自己的地址当池地址");
  }
  assert.ok(lines.some((l) => l.includes("出口池就绪")), "必须有池结论行");
  assert.ok(lines.filter((l) => l.includes("探活")).length === 2, "每个地址一行探活结果");
  await pool.close();
});

test("index：探活全失败 ⇒ 池为空（宁可直连也不黑洞）并当场释放所有认领的地址", async () => {
  const lines = [];
  const claimer = fakeClaimer();
  const pool = createV6Pool({
    env: { MSLXDFF_V6_COUNT: "2" },
    log: (l) => lines.push(l),
    deps: {
      detect: DETECT_OK,
      claimer: () => claimer,
      probe: async () => ({ ok: false, status: 0, ms: 1, error: "timeout" }),
      agentFactory: (a) => captureAgent(a),
      exitHook: false,
    },
  });
  await pool.ready;
  assert.equal(pool.dispatcher.size, 0, "探活全失败 ⇒ 池必须为空");
  assert.equal(claimer.released.length, 2, "探不通的地址要当场释放");
  const last = lines[lines.length - 1];
  assert.match(last, /全部/);
  assert.match(last, /MSLXDFF_V6_POOL=0/, "跳过原因必须给出回退命令");
  await pool.close();
});

test("index：出口池二选一——v6 关掉且 WARP 也关 ⇒ undefined（退路接线正确）", () => {
  const lines = [];
  const disp = createPreferredDispatcher({ env: { MSLXDFF_V6_POOL: "0", MSLXDFF_WARP_POOL: "0" }, log: (l) => lines.push(l) });
  assert.equal(disp, undefined);
  assert.ok(lines.some((l) => l.includes("出口池关着")));
});

// ---------- report：日志契约 ----------

test("report：换址行必须自带定位信息（哪个源→哪个源、什么判决、第几次、旧地址计数）", () => {
  assert.equal(fmtCounts({ 200: 3, 429: 1 }), "200×3 429×1");
  assert.equal(fmtCounts({}), "无响应");
  const sw = fmtSwap({ from: "OLD", to: "NEW", status: 429, kind: "free-quota", forced: true, swaps: 2, prevCounts: { 200: 1, 429: 3 } });
  for (const needle of ["OLD", "NEW", "429", "free-quota", "第 2 次", "200×1", "429×3"]) {
    assert.ok(sw.includes(needle), `换址行缺 ${needle}：${sw}`);
  }
});

test("report：首个 200 的取证行——换过址才说「换址后恢复」，没换过不许说", () => {
  const after = fmtFirstOk({ addr: "B", swaps: 2, counts: { 200: 1 } });
  assert.match(after, /换址后立刻恢复/);
  assert.ok(after.includes("第 2 次"));
  const fresh = fmtFirstOk({ addr: "B", swaps: 0, counts: { 200: 1 } });
  assert.ok(fresh.includes("首个响应 200"));
  assert.ok(!fresh.includes("换址后"), "没换过址就不许说换址后恢复（假警报比沉默更糟）");
});

test("report：跳过/自检/池结论/探活行的契约", () => {
  const skip = fmtSkip({ reason: "无 IPv6", hint: "装 IPv6" });
  assert.ok(skip.includes("无 IPv6") && skip.includes("装 IPv6") && skip.includes("不启用"));
  const det = fmtDetect({ iface: "eth0", prefix: "p/64", hostBits: 64, mode: "bind", source: "proc" });
  assert.ok(det.includes("eth0") && det.includes("2^64") && det.includes("不碰网卡"));
  const detAdd = fmtDetect({ iface: "eth0", prefix: "p/64", hostBits: 64, mode: "add", source: "proc" });
  assert.ok(detAdd.includes("ip addr add"));
  const pool = fmtPool({ prefix: "p/64", addrs: ["A", "B"], claimed: 2, mode: "add" });
  assert.ok(pool.includes("p/64") && pool.includes("A") && pool.includes("B") && pool.includes("就绪"));
  const pe = fmtPoolEmpty({ tried: 4 });
  assert.ok(pe.includes("4") && pe.includes("MSLXDFF_V6_POOL=0"));
  const pr = fmtProbe({ addr: "A", i: 1, n: 2, ok: true, status: 200, ms: 7 });
  assert.ok(pr.includes("1/2") && pr.includes("200") && pr.includes("7ms"));
  const prFail = fmtProbe({ addr: "A", i: 1, n: 2, ok: false, status: 0, ms: 7, error: "timeout" });
  assert.ok(prFail.includes("timeout"));
  const cfg = fmtConfig({ enabled: true, count: 4, strategy: "session", rotate: true, claim: "auto", cooldownMs: 600_000, retireMs: 60_000, prefix: "" });
  assert.ok(cfg.includes("槽位=4") && cfg.includes("(自动判断)"));
});
