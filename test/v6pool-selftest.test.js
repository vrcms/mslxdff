// v6pool 出口对照测试（selftest.js）：四关跳过、基线对照判语、认领/释放账目。
// 全程注入 detect/claimer/agentFactory/probe，零真机依赖。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runV6PoolCompare,
  probeUpstreamFrom,
  freeLaneBody,
  freeLaneHeaders,
  V6TEST_DEFAULT,
} from "../src/v6pool/selftest.js";
import { CORE_AGENT_TOOL_NAMES } from "../src/free-lane.js";

/** 假 detect：直接给一个可用池（/64，bind 模式）。 */
const okDetect = () => ({ ok: true, addr: "2001:db8::1", bits: 64, iface: "eth0", hostBits: 64, mode: "bind", source: "env", prefix: "2001:db8::/64", mine: ["2001:db8::1"] });
const skipDetect = () => ({ ok: false, reason: "本平台（win32）不支持", hint: "非 Linux 机器不需要本功能" });

/** 假 claimer：记账但不碰网卡。 */
function fakeClaimer() {
  const claimed = new Set();
  return {
    ensured: [],
    async ensure(a) { claimed.add(a); this.ensured.push(a); return a; },
    async releaseAll() { const n = claimed.size; claimed.clear(); this.released = n; return [...this.ensured]; },
    claimed: () => [...claimed],
  };
}

const fakeAgentFactory = () => ({ close: async () => {} });
const seqAddrs = (list) => { let i = 0; return () => list[i++ % list.length]; };

test("compare: 非 Linux → 如实跳过，不假装（带下一步提示）", async () => {
  const r = await runV6PoolCompare({ env: {}, deps: { detect: skipDetect } });
  assert.equal(r.status, "skip");
  assert.match(r.reason, /win32/);
  assert.ok(r.hint.length > 0, "跳过必须给「下一步」，不能只说不可用");
});

test("compare: 基线 429 + v6 有 200 → verdict=v6-works（池有用）", async () => {
  const claimer = fakeClaimer();
  const r = await runV6PoolCompare({
    env: {}, count: 3,
    deps: {
      detect: okDetect, claimer: () => claimer, agentFactory: fakeAgentFactory,
      randomAddress: seqAddrs(["2001:db8::a", "2001:db8::b", "2001:db8::c"]),
      probe: async ({ addr }) => (addr === "" // 直连基线
        ? { addr, ok: false, status: 429, kind: "free-quota", rotate: true, ms: 10, body: "FreeUsageLimitError" }
        : { addr, ok: true, status: 200, kind: "none", rotate: false, ms: 20, body: "" }),
    },
  });
  assert.equal(r.verdict, "v6-works");
  assert.equal(r.baseLimited, true, "基线必须被判为额度耗尽");
  assert.equal(r.v6OkCount, 3);
  assert.equal(claimer.released, 3, "自造的 3 个地址必须全释放");
});

test("compare: 基线 429 + v6 也全 429 → verdict=v6-also-limited（换 IP 抬不动）", async () => {
  const r = await runV6PoolCompare({
    env: {}, count: 3,
    deps: {
      detect: okDetect, claimer: () => fakeClaimer(), agentFactory: fakeAgentFactory,
      randomAddress: seqAddrs(["2001:db8::a", "2001:db8::b", "2001:db8::c"]),
      probe: async ({ addr }) => ({ addr, ok: false, status: 429, kind: "free-quota", rotate: true, ms: 10, body: "FreeUsageLimitError" }),
    },
  });
  assert.equal(r.verdict, "v6-also-limited");
  assert.equal(r.v6LimitedCount, 3);
});

test("compare: v6 全够不着上游 → verdict=v6-unreachable（段没路由过来）", async () => {
  const r = await runV6PoolCompare({
    env: {}, count: 2,
    deps: {
      detect: okDetect, claimer: () => fakeClaimer(), agentFactory: fakeAgentFactory,
      randomAddress: seqAddrs(["2001:db8::a", "2001:db8::b"]),
      probe: async ({ addr }) => (addr === "" ? { addr, ok: true, status: 200, kind: "none", rotate: false, ms: 5, body: "" } : { addr, ok: false, status: 0, kind: "network", rotate: true, ms: 8000, error: "ETIMEDOUT", body: "" }),
    },
  });
  assert.equal(r.verdict, "v6-unreachable");
  assert.equal(r.v6NetCount, 2);
});

test("compare: 部分 v6 成功 → verdict=mixed", async () => {
  const addrs = ["2001:db8::a", "2001:db8::b", "2001:db8::c", "2001:db8::d"];
  const okSet = new Set(["2001:db8::a", "2001:db8::c"]); // 两个成功、两个 429
  const r = await runV6PoolCompare({
    env: {}, count: 4,
    deps: {
      detect: okDetect, claimer: () => fakeClaimer(), agentFactory: fakeAgentFactory,
      randomAddress: seqAddrs(addrs),
      probe: async ({ addr }) => (addr === ""
        ? { addr, ok: false, status: 429, kind: "free-quota", rotate: true, ms: 5, body: "" }
        : okSet.has(addr)
          ? { addr, ok: true, status: 200, kind: "none", rotate: false, ms: 5, body: "" }
          : { addr, ok: false, status: 429, kind: "free-quota", rotate: true, ms: 5, body: "" }),
    },
  });
  assert.equal(r.verdict, "mixed");
  assert.equal(r.v6OkCount, 2);
  assert.equal(r.v6LimitedCount, 2);
});

test("compare: 每个 v6 样本都用了不同的源地址（对照才有意义）", async () => {
  const seen = [];
  await runV6PoolCompare({
    env: {}, count: 3,
    deps: {
      detect: okDetect, claimer: () => fakeClaimer(), agentFactory: fakeAgentFactory,
      randomAddress: seqAddrs(["2001:db8::a", "2001:db8::b", "2001:db8::c"]),
      probe: async ({ addr }) => { seen.push(addr); return { addr, ok: true, status: 200, kind: "none", rotate: false, ms: 1, body: "" }; },
    },
  });
  const v6 = seen.filter((a) => a !== "");
  assert.deepEqual(v6, ["2001:db8::a", "2001:db8::b", "2001:db8::c"]);
});

test("freeLaneBody: 必须 stream:true + 五核心工具名（否则 403 而非 429，测不出额度）", () => {
  const b = freeLaneBody("m-free");
  assert.equal(b.stream, true);
  const names = b.tools.map((t) => t.function.name);
  for (const n of CORE_AGENT_TOOL_NAMES) assert.ok(names.includes(n), `缺工具 ${n} 会 403`);
});

test("probeUpstreamFrom: 429 正文含 FreeUsageLimitError → kind=free-quota，且判 rotate", async () => {
  const r = await probeUpstreamFrom({
    addr: "",
    model: "m-free",
    fetchImpl: async () => ({ status: 429, text: async () => `{"error":{"type":"FreeUsageLimitError","message":"x"}}` }),
  });
  assert.equal(r.status, 429);
  assert.equal(r.kind, "free-quota");
  assert.equal(r.rotate, true, "额度信号必须判可换出口（与生产同源）");
});

test("probeUpstreamFrom: 200 → ok=true，不换", async () => {
  const r = await probeUpstreamFrom({ addr: "", model: "m-free", fetchImpl: async () => ({ status: 200, text: async () => "data: ok" }) });
  assert.equal(r.ok, true);
  assert.equal(r.kind, "none");
});

test("probeUpstreamFrom: 网络异常 → status=0 kind=network，不抛", async () => {
  const r = await probeUpstreamFrom({ addr: "2001:db8::a", model: "m-free", agentFactory: fakeAgentFactory, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(r.status, 0);
  assert.equal(r.kind, "network");
  assert.match(r.error, /ECONNREFUSED/);
});

test("compare: 默认采样数是 6，且非 Linux 时不发任何请求", async () => {
  assert.equal(V6TEST_DEFAULT, 6);
  let called = 0;
  const r = await runV6PoolCompare({ env: {}, deps: { detect: skipDetect, probe: async () => { called += 1; return {}; } } });
  assert.equal(r.status, "skip");
  assert.equal(called, 0, "检测不过就不该发任何探测请求");
});

test("freeLaneHeaders: 必带免费层身份四件套（缺了必 403 FreeTierError，测不出额度）", () => {
  const h = freeLaneHeaders();
  assert.equal(h["x-opencode-client"], "desktop");
  assert.match(h["x-opencode-session"], /^ses_/, "缺 session → 403");
  assert.match(h["x-opencode-request"], /^msg_/, "缺 request → 403");
  assert.equal(h["x-opencode-project"], "global");
  assert.ok(h["User-Agent"].startsWith("opencode/"), "UA 非 opencode/ 会被挡");
  // 传入 session 时用它（保证整轮对照共用同一个）
  assert.equal(freeLaneHeaders({ session: "ses_fixed" })["x-opencode-session"], "ses_fixed");
});

test("probeUpstreamFrom: 请求**真的带上**身份四件套（回归：只发 UA 会 403）", async () => {
  let sent = null;
  await probeUpstreamFrom({
    addr: "", model: "m-free", session: "ses_shared",
    fetchImpl: async (url, init) => { sent = init.headers; return { status: 200, text: async () => "data: ok" }; },
  });
  assert.equal(sent["x-opencode-client"], "desktop");
  assert.equal(sent["x-opencode-session"], "ses_shared", "整轮对照应共用传入的 session");
  assert.ok(sent["x-opencode-request"], "必须带 x-opencode-request");
  assert.equal(sent["x-opencode-project"], "global");
});

test("compare: 全 403 FreeTierError → verdict=v6-also-limited（回归：旧实现会误判 mixed「部分可用」）", async () => {
  const r = await runV6PoolCompare({
    env: {}, count: 3,
    deps: {
      detect: okDetect, claimer: () => fakeClaimer(), agentFactory: fakeAgentFactory,
      randomAddress: seqAddrs(["2001:db8::a", "2001:db8::b", "2001:db8::c"]),
      // 403（免费层资格）——旧实现只认 429，会让 0/3 掉进兜底 mixed
      probe: async ({ addr }) => ({ addr, ok: false, status: 403, kind: "free-tier", rotate: true, ms: 10, body: "FreeTierError" }),
    },
  });
  assert.equal(r.verdict, "v6-also-limited", "有 HTTP 响应但 0 额度必须判受限，不能报「部分可用」");
  assert.equal(r.v6LimitedCount, 3);
  assert.equal(r.v6NetCount, 0);
});

test("compare: 整轮基线+v6 共用同一个 session（差异只来自源地址）", async () => {
  const sessions = [];
  await runV6PoolCompare({
    env: {}, count: 2,
    deps: {
      detect: okDetect, claimer: () => fakeClaimer(), agentFactory: fakeAgentFactory,
      randomAddress: seqAddrs(["2001:db8::a", "2001:db8::b"]),
      probe: async ({ addr, session }) => { sessions.push(session); return { addr, ok: true, status: 200, kind: "none", rotate: false, ms: 1, body: "" }; },
    },
  });
  assert.ok(sessions.length >= 3, "基线 + 2 个 v6 样本");
  assert.equal(new Set(sessions).size, 1, "整轮必须共用同一个 session");
});
