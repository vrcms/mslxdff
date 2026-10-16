// warp-pool 离线测试：不触网、不起隧道进程、不真等待（sleep/wait 全部注入）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateWgKeyPair, isWgKey } from "../src/warp-pool/keys.js";
import { DEFAULTS, resolveWarpConfig } from "../src/warp-pool/config.js";
import { loadNode, loadNodes, renderWireproxyConf, saveNode } from "../src/warp-pool/nodes.js";
import { backoffMs, buildRegisterBody, parseRegisterResponse, registerWarpDevice } from "../src/warp-pool/register.js";
import { createSelector } from "../src/warp-pool/strategy.js";
import { createRotatingDispatcher, headerValue } from "../src/warp-pool/rotate.js";
import { createHealthMonitor } from "../src/warp-pool/health.js";
import { parseExitIp, createReviver, labelExits } from "../src/warp-pool/revive.js";
import { createWarpDispatcher, createWarpPool, redialPlan } from "../src/warp-pool/index.js";
import { writeTunnelConf } from "../src/warp-pool/wireproxy.js";

const tmp = () => mkdtempSync(join(tmpdir(), "warp-pool-test-"));
const logDirFn = () => join(tmpdir(), "warp-pool-logdir");

// ---------- keys ----------

test("keys：WireGuard 密钥形状合法且每次不同", () => {
  const a = generateWgKeyPair();
  const b = generateWgKeyPair();
  assert.ok(isWgKey(a.privateKey), `私钥形状不合法：${a.privateKey}`);
  assert.ok(isWgKey(a.publicKey), `公钥形状不合法：${a.publicKey}`);
  assert.notEqual(a.privateKey, b.privateKey, "两次生成必须不同");
  assert.notEqual(a.publicKey, b.publicKey, "两次生成必须不同");
  assert.equal(isWgKey("tooshort"), false);
  assert.equal(isWgKey(null), false);
  assert.equal(isWgKey(""), false);
});

// ---------- config ----------

test("config：缺省关（2026-10-16 真机实测证伪「N 设备 = N 桶」后改回）；显式开且 leader 才建池", () => {
  const def = resolveWarpConfig({}, { logDirFn });
  assert.equal(def.enabled, false, "缺省关：不设 env 就不该有人偷偷被切到共享出口");
  assert.equal(def.active, false);
  assert.equal(resolveWarpConfig({ MSLXDFF_WARP_POOL: "1" }, { logDirFn }).active, true, "显式开必须生效");

  const on = resolveWarpConfig({ MSLXDFF_WARP_POOL: "1" }, { logDirFn });
  assert.equal(on.active, true);
  assert.equal(on.mode, "leader");
  assert.equal(on.count, DEFAULTS.count);
  assert.deepEqual(on.ports, [10800, 10801, 10802, 10803], "端口必须是 basePort..basePort+count-1");

  const member = resolveWarpConfig({ MSLXDFF_WARP_POOL: "1", MSLXDFF_WARP_MODE: "member" }, { logDirFn });
  assert.equal(member.enabled, true);
  assert.equal(member.active, false, "成员模式不得建池");

  const custom = resolveWarpConfig(
    { MSLXDFF_WARP_POOL: "on", MSLXDFF_WARP_COUNT: "2", MSLXDFF_WARP_BASE_PORT: "12000", MSLXDFF_WARP_STRATEGY: "request" },
    { logDirFn },
  );
  assert.equal(custom.active, true);
  assert.deepEqual(custom.ports, [12000, 12001]);
  assert.equal(custom.strategy, "request");
  assert.equal(resolveWarpConfig({ MSLXDFF_WARP_STRATEGY: "bogus" }, { logDirFn }).strategy, "session", "非法策略回落到 session");
});

// ---------- nodes ----------

test("nodes：写读往返，且 INI 用 [http] 段（undici v5 的 ProxyAgent 不吃 socks5）", () => {
  const dir = tmp();
  const node = { port: 10800, id: "id-1", token: "tk-1", v4: "172.16.0.2", v6: "2606:4700::1", endpoint: "engage:2408", peerKey: "PK=" };
  saveNode(dir, node);
  const back = loadNode(dir, 10800);
  assert.equal(back.id, "id-1");
  assert.equal(back.token, "tk-1");
  assert.equal(back.v6, "2606:4700::1");
  assert.equal(loadNode(dir, 19999), null, "缺失节点必须返回 null 而不是抛");

  const conf = renderWireproxyConf({ privateKey: "PRIVKEY=", v4: "172.16.0.2", v6: "2606:4700::1", endpoint: "engage:2408", peerKey: "PUBKEY=", port: 10800 });
  assert.match(conf, /\[http\]/, "必须是 [http] 段");
  assert.match(conf, /BindAddress = 127\.0\.0\.1:10800/);
  assert.match(conf, /PrivateKey = PRIVKEY=/);
  assert.match(conf, /Address = 172\.16\.0\.2\/32/);
  assert.match(conf, /Address = 2606:4700::1\/128/);
  assert.equal(/\[Socks5\]/.test(conf), false, "禁止 [Socks5]：实测 undici v5 抛 Invalid URL protocol");
});

test("nodes：敏感文件权限 0600（仅 POSIX 有意义）", { skip: process.platform === "win32" }, () => {
  const dir = tmp();
  saveNode(dir, { port: 10801, id: "a", token: "b" });
  const mode = statSync(join(dir, "node-10801.json")).mode & 0o777;
  assert.equal(mode, 0o600, "节点元数据含设备 token，必须 0600");
});

// ---------- register ----------

test("register：请求体与响应解析", () => {
  const body = buildRegisterBody({ publicKey: "PUB=", uuid: "uuid-1", now: () => Date.parse("2026-10-16T12:00:00.000Z") });
  assert.equal(body.key, "PUB=");
  assert.equal(body.serial_number, "uuid-1");
  assert.equal(body.type, "Android");
  assert.equal(body.tos, "2026-10-16T12:00:00.000Z", "tos 必须是毫秒截断的 ISO 串");

  const parsed = parseRegisterResponse({
    id: "id-1",
    token: "tk-1",
    config: {
      interface: { addresses: { v4: "172.16.0.2", v6: "2606:4700:110::1" } },
      peers: [{ public_key: "PEER=", endpoint: { host: "engage.cloudflareclient.com:2408" } }],
    },
  });
  assert.equal(parsed.id, "id-1");
  assert.equal(parsed.v6, "2606:4700:110::1");
  assert.equal(parsed.endpoint, "engage.cloudflareclient.com:2408");
  assert.throws(() => parseRegisterResponse({ id: "x" }), /缺少必要字段/);
});

test("register：429/403 长退避，网络类错误短退避", () => {
  const zero = () => 0;
  assert.ok(backoffMs(429, 1, zero) >= 60_000, "429 必须长退避（短退避会被续封）");
  assert.ok(backoffMs(403, 1, zero) >= 60_000, "403 必须长退避");
  assert.ok(backoffMs(0, 1, zero) < 60_000, "网络错误走短退避");
  assert.ok(backoffMs(500, 1, zero) < 60_000);
});

test("register：首个 429 后退避重试并成功（sleep 注入，不真等）", async () => {
  const waits = [];
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ error: { code: 1015 } }), { status: 429 });
    return new Response(
      JSON.stringify({
        id: "id-9",
        token: "tk-9",
        config: {
          interface: { addresses: { v4: "172.16.0.2", v6: "2606:4700::9" } },
          peers: [{ public_key: "PEER=", endpoint: { host: "engage.cloudflareclient.com:2408" } }],
        },
      }),
      { status: 200 },
    );
  };
  const r = await registerWarpDevice({ fetchImpl, sleep: async (ms) => waits.push(ms), log: () => {} });
  assert.equal(calls, 2, "第一次 429 后必须重试");
  assert.equal(r.id, "id-9");
  assert.ok(isWgKey(r.privateKey), "必须带回本地生成的私钥");
  assert.equal(waits.length, 1);
  assert.ok(waits[0] >= 60_000, `429 的重试间隔必须长退避，实际 ${waits[0]}`);
});

test("register：全部失败时抛出人话错误（含最后状态码）", async () => {
  const fetchImpl = async () => new Response("boom", { status: 500 });
  await assert.rejects(
    () => registerWarpDevice({ fetchImpl, sleep: async () => {}, log: () => {}, maxAttempts: 2 }),
    /WARP 注册失败.*HTTP 500/,
  );
});

// ---------- strategy ----------

test("strategy：session 粘性、request 轮转、候选耗尽时重选", () => {
  const s = createSelector({ strategy: "session" });
  const first = s.pick([0, 1, 2], "ses_A");
  assert.equal(s.pick([0, 1, 2], "ses_A"), first, "同 session 恒同出口");
  assert.equal(s.pick([0, 1, 2], "ses_A"), first);
  const other = s.pick([0, 1, 2], "ses_B");
  assert.notEqual(other, first, "不同 session 应分散到别的出口");
  assert.equal(s.pick([2], "ses_A"), 2, "原出口不可用时必须重选到可用者");
  assert.equal(s.pick([], "ses_A"), null, "无候选返回 null");

  const r = createSelector({ strategy: "request" });
  assert.deepEqual([r.pick([5, 6], null), r.pick([5, 6], null), r.pick([5, 6], null)], [5, 6, 5]);
});

// ---------- rotate ----------

test("rotate：headerValue 解析 undici 扁平头数组", () => {
  const headers = ["content-type", "application/json", "x-opencode-session", "ses_abc"];
  assert.equal(headerValue(headers, "X-OpenCode-Session"), "ses_abc");
  assert.equal(headerValue(headers, "x-opencode-session"), "ses_abc");
  assert.equal(headerValue(headers, "absent"), "");
  assert.equal(headerValue(null, "x"), "");
  assert.equal(headerValue({ a: 1 }, "a"), "");
});

function fakeAgents() {
  const seen = [];
  const mk = (uri) => ({
    uri,
    dispatch: () => {
      seen.push(uri);
      return true;
    },
    close: async () => {},
  });
  return { seen, agentFactory: mk, fallbackAgent: mk("direct") };
}

test("rotate：空池走直连兜底；setNodes 后按策略轮换；close 幂等", async () => {
  const { seen, agentFactory, fallbackAgent } = fakeAgents();
  const d = createRotatingDispatcher({ nodes: [], agentFactory, fallbackAgent });

  assert.equal(d.size, 0);
  assert.deepEqual(d.entries(), []);
  d.dispatch({ headers: [] }, {});
  assert.deepEqual(seen, ["direct"], "空池必须走直连兜底（行为与未启用一致）");

  const n = await d.setNodes([
    { port: 10800, uri: "http://127.0.0.1:10800" },
    { port: 10801, uri: "http://127.0.0.1:10801" },
  ]);
  assert.equal(n, 2);
  assert.equal(d.size, 2);

  seen.length = 0;
  d.dispatch({ headers: ["x-opencode-session", "s1"] }, {});
  d.dispatch({ headers: ["x-opencode-session", "s1"] }, {});
  d.dispatch({ headers: ["x-opencode-session", "s2"] }, {});
  assert.equal(seen[0], seen[1], "同 session 粘同一出口");
  assert.notEqual(seen[0], seen[2], "不同 session 分散到不同出口");

  // 冷却：标记失败后该节点必须暂时退出候选
  d.markFailure(0);
  const stats = d.stats();
  assert.equal(stats[0].cooling, true);
  assert.equal(stats[1].cooling, false);
  seen.length = 0;
  for (let i = 0; i < 3; i++) d.dispatch({ headers: ["x-opencode-session", `s${i}`] }, {});
  assert.ok(!seen.includes("http://127.0.0.1:10800"), "冷却中的节点不得被选中");

  d.markOk(0);
  assert.equal(d.stats()[0].cooling, false, "恢复后冷却解除");

  await d.close();
  await d.close();
  assert.equal(d.size, 0, "close 幂等且清空池");
});

// ---------- health ----------

test("health：按节点探活累计成败；全池不可用连续两轮才触发重拨", async () => {
  const failed = [];
  const oked = [];
  const dispatcher = {
    entries: () => [
      { index: 0, port: 10800 },
      { index: 1, port: 10801 },
    ],
    markFailure: (i) => failed.push(i),
    markOk: (i) => oked.push(i),
  };

  let exhausts = 0;
  const partial = createHealthMonitor({
    dispatcher,
    probe: async ({ port }) => ({ ok: port === 10800 }),
    onExhausted: async () => {
      exhausts += 1;
    },
  });
  assert.deepEqual(await partial.tick(), { checked: 2, healthy: 1 });
  assert.deepEqual(oked, [0]);
  assert.deepEqual(failed, [1]);

  const dead = createHealthMonitor({
    dispatcher: { ...dispatcher, entries: () => [{ index: 0, port: 10800 }] },
    probe: async () => ({ ok: false }),
    onExhausted: async () => {
      exhausts += 1;
    },
  });
  await dead.tick();
  assert.equal(exhausts, 0, "第一轮全挂不触发重拨");
  await dead.tick();
  assert.equal(exhausts, 1, "连续两轮全挂才重拨（避免抖动就换 IP）");
});

test("health：probe 抛异常按失败处理，不让探活打崩轮次", async () => {
  const failed = [];
  const h = createHealthMonitor({
    dispatcher: { entries: () => [{ index: 0, port: 10800 }], markFailure: (i) => failed.push(i), markOk: () => {} },
    probe: async () => {
      throw new Error("boom");
    },
  });
  const r = await h.tick();
  assert.deepEqual(r, { checked: 1, healthy: 0 });
  assert.deepEqual(failed, [0]);
});

// ---------- index ----------

test("index：显式关 / member 模式返回 null——不建池、零副作用", () => {
  assert.equal(createWarpPool({ env: { MSLXDFF_WARP_POOL: "0" }, log: () => {} }), null);
  assert.equal(createWarpPool({ env: { MSLXDFF_WARP_MODE: "member" }, log: () => {} }), null, "缺省开但成员模式不建池");
  assert.equal(createWarpPool({ env: { MSLXDFF_WARP_POOL: "off" }, log: () => {} }), null);
});

test("index：leader 模式用注入件走完 bootstrap（不触网、不起进程、不真等）", async () => {
  const dir = tmp();
  const started = [];
  const waits = [];
  const pool = createWarpPool({
    env: {
      MSLXDFF_WARP_POOL: "1",
      MSLXDFF_WARP_DIR: dir,
      MSLXDFF_WARP_COUNT: "2",
      MSLXDFF_WARP_BASE_PORT: "10900",
    },
    log: () => {},
    ensureBin: async () => "C:/fake/wireproxy",
    register: async () => ({ id: "id", token: "tk", v4: "172.16.0.2", v6: "2606:4700::2", peerKey: "PK=", endpoint: "e:2408", privateKey: "PRIVKEY=" }),
    start: ({ port }) => {
      started.push(port);
      return { port, stop() {} };
    },
    probe: async () => ({ ok: true, status: 200 }),
    wait: async (ms) => waits.push(ms),
    rnd: () => 0,
  });

  assert.ok(pool, "leader + 开关开 必须建池");
  await pool.ready;

  assert.deepEqual(started, [10900, 10901], "应按端口顺序把两个节点都拉起来");
  assert.equal(pool.stats().tunnels, 2);
  assert.equal(pool.stats().nodes.length, 2);
  assert.ok(waits.length >= 1, "第二个及以后的注册之间必须留间隔（防风控撞号）");

  // 节点元数据含私钥相关字段，必须落盘在指定目录
  assert.equal(loadNode(dir, 10900).id, "id");

  await pool.close();
  assert.equal(pool.stats().tunnels, 0, "close 必须停掉全部隧道");
});

test("index：createWarpDispatcher 未启用时返回 undefined（调用方可直接透传）", () => {
  assert.equal(createWarpDispatcher({ env: { MSLXDFF_WARP_POOL: "0" }, log: () => {} }), undefined);
  assert.equal(createWarpDispatcher({ env: { MSLXDFF_WARP_MODE: "member" }, log: () => {} }), undefined, "缺省开但成员模式不建池");
});

test("index：开关开 + leader 即建池（组长升级/重启即生效的路径）", async () => {
  const dir = tmp();
  const started = [];
  const pool = createWarpPool({
    env: { MSLXDFF_WARP_POOL: "1", MSLXDFF_WARP_DIR: dir, MSLXDFF_WARP_COUNT: "1", MSLXDFF_WARP_BASE_PORT: "10950" },
    log: () => {},
    ensureBin: async () => "C:/fake/wireproxy",
    register: async () => ({ id: "id", token: "tk", v4: "172.16.0.2", v6: "2606:4700::9", peerKey: "PK=", endpoint: "e:2408", privateKey: "PRIVKEY=" }),
    start: ({ port }) => {
      started.push(port);
      return { port, stop() {} };
    },
    probe: async () => ({ ok: true, status: 200 }),
    wait: async () => {},
    rnd: () => 0,
  });
  assert.ok(pool, "显式开必须建池");
  await pool.ready;
  assert.deepEqual(started, [10950]);
  assert.equal(pool.stats().tunnels, 1);
  await pool.close();
});

test("redialPlan：隧道全活不重拨；有死隧道且过退避才放行（防把 CF 注册刷到 429 拉黑）", () => {
  const base = { ports: [10800, 10801], redialGapMs: 300_000, now: () => 1_000_000 };
  assert.deepEqual(
    redialPlan({ ...base, alivePorts: [10800, 10801], lastRedialAt: 0 }),
    { dead: [], reason: "all-alive" },
    "隧道进程都活着却探活全挂 = 网络路径问题（墙内 UDP 被屏蔽），重拨毫无意义",
  );
  assert.deepEqual(
    redialPlan({ ...base, alivePorts: [10800], lastRedialAt: 0 }),
    { dead: [10801], reason: "ok" },
    "只剩死隧道且过了退避 ⇒ 放行",
  );
  assert.deepEqual(
    redialPlan({ ...base, alivePorts: [10800], lastRedialAt: 1_000_000 - 10_000 }),
    { dead: [10801], reason: "throttled" },
    "距上次重拨不足退避间隔 ⇒ 掐住",
  );
  assert.deepEqual(
    redialPlan({ ...base, alivePorts: [10800], lastRedialAt: 1_000_000 - 300_000 }),
    { dead: [10801], reason: "ok" },
    "刚好满退避间隔 ⇒ 放行",
  );
});

test("index：入池前实测探活——探活不过的隧道绝不进池", async () => {
  const dir = tmp();
  const pool = createWarpPool({
    env: { MSLXDFF_WARP_POOL: "1", MSLXDFF_WARP_DIR: dir, MSLXDFF_WARP_COUNT: "2", MSLXDFF_WARP_BASE_PORT: "10970" },
    log: () => {},
    ensureBin: async () => "C:/fake/wireproxy",
    register: async () => ({ id: "id", token: "tk", v4: "172.16.0.2", v6: "2606:4700::b", peerKey: "PK=", endpoint: "e:2408", privateKey: "PRIVKEY=" }),
    start: ({ port }) => ({ port, stop() {} }),
    probe: async ({ port }) => ({ ok: port === 10971, status: port === 10971 ? 200 : 0 }),
    wait: async () => {},
    rnd: () => 0,
  });
  await pool.ready;
  assert.equal(pool.stats().tunnels, 2, "两条隧道进程都活着");
  const nodes = pool.stats().nodes;
  assert.equal(nodes.length, 1, "只有探活通过的节点才进池");
  assert.equal(nodes[0].port, 10971);
  await pool.close();
});

test("index：探活全不过 ⇒ 池为空（dispatcher 直连兜底，绝不把请求派给转不动流量的隧道）", async () => {
  const dir = tmp();
  const pool = createWarpPool({
    env: { MSLXDFF_WARP_POOL: "1", MSLXDFF_WARP_DIR: dir, MSLXDFF_WARP_COUNT: "1", MSLXDFF_WARP_BASE_PORT: "10980" },
    log: () => {},
    ensureBin: async () => "C:/fake/wireproxy",
    register: async () => ({ id: "id", token: "tk", v4: "172.16.0.2", v6: "2606:4700::c", peerKey: "PK=", endpoint: "e:2408", privateKey: "PRIVKEY=" }),
    start: ({ port }) => ({ port, stop() {} }),
    probe: async () => ({ ok: false, status: 0, error: "handshake timeout" }),
    wait: async () => {},
    rnd: () => 0,
  });
  await pool.ready;
  assert.equal(pool.stats().tunnels, 1, "隧道进程活着");
  assert.equal(pool.stats().nodes.length, 0, "探活不过 ⇒ 池必须为空，否则 opencode 被黑洞");
  await pool.close();
});

test("nodes：saveNode/loadNode 必须往返 privateKey（2026-10-16 真机事故：漏读回 ⇒ conf 写成「PrivateKey = undefined」⇒ 复用节点的隧道全起不来）", () => {
  const dir = tmp();
  const key = generateWgKeyPair();
  saveNode(dir, { port: 10810, id: "id", token: "tk", v4: "172.16.0.2", v6: "2606:4700::1", endpoint: "engage:2408", peerKey: "PK=", privateKey: key.privateKey });
  const back = loadNode(dir, 10810);
  assert.equal(back.privateKey, key.privateKey, "私钥必须读回：bringUp 靠它渲染 conf");
  const conf = renderWireproxyConf(back);
  assert.ok(conf.includes(`PrivateKey = ${key.privateKey}`), "conf 必须带真私钥");
  assert.equal(conf.includes("PrivateKey = undefined"), false, "绝不能写出 undefined 私钥");
});

test("nodes：缺私钥的节点必须被 loadNodes 丢弃（宁可重新注册，也不写一份跑不起来的 conf）", () => {
  const dir = tmp();
  saveNode(dir, { port: 10811, id: "id", token: "tk" }); // 旧格式/无私钥
  saveNode(dir, { port: 10812, id: "id", token: "tk", privateKey: "PRIV=" });
  assert.deepEqual(loadNodes(dir, [10811, 10812]).map((n) => n.port), [10812]);
});

test("wireproxy：writeTunnelConf 缺私钥直接抛——绝不写出「PrivateKey = undefined」让它静默跑不起来", () => {
  const dir = tmp();
  assert.throws(() => writeTunnelConf(dir, { port: 10813, v4: "172.16.0.2" }), /缺 WireGuard 私钥/);
});

test("revive：首次退出立即复活；连败按 30s→10min 指数退避（进程挂了才复活，不重注册）", async () => {
  let t = 1_000_000;
  const calls = [];
  const r = createReviver({ revive: async (p) => (calls.push(p), true), now: () => t, minGapMs: 30_000, maxGapMs: 600_000 });
  assert.equal(await r.onExit(10800), true, "首次必须立即复活");
  assert.deepEqual(calls, [10800]);
  assert.equal(await r.onExit(10800), true, "复活成功后账已清 ⇒ 再退出仍立即复活");
  t += 1;
  const r2 = createReviver({ revive: async () => false, now: () => t, minGapMs: 30_000, maxGapMs: 600_000 });
  assert.equal(await r2.onExit(10801), false);
  assert.equal(await r2.onExit(10801), false, "退避窗口内不重复尝试");
  t += 30_000;
  assert.equal(await r2.onExit(10801), false, "满 30s 后再试一次");
  assert.equal(r2.stats()[0].attempts, 2);
  t += 60_000;
  await r2.onExit(10801);
  assert.equal(r2.stats()[0].attempts, 3, "退避按 30s→60s→… 递增");
});

test("revive：noteHealthy 清账；两个端口互不影响（一条死不该拖累另一条）", async () => {
  let t = 0;
  const tried = [];
  const r = createReviver({ revive: async (p) => (tried.push(p), false), now: () => t, minGapMs: 30_000 });
  await r.onExit(10800);
  await r.onExit(10801);
  assert.deepEqual(tried, [10800, 10801], "各自独立尝试");
  assert.equal(r.stats().length, 2);
  r.noteHealthy(10800);
  assert.deepEqual(r.stats().map((s) => s.port), [10801], "noteHealthy 只清该端口");
});

test("revive：parseExitIp 只认 ip= 行（CF trace 正文形态）", () => {
  assert.equal(parseExitIp("fl=1\nip=104.28.243.105\nts=1\n"), "104.28.243.105");
  assert.equal(parseExitIp("ip=2606:4700:110::1\n"), "2606:4700:110::1");
  assert.equal(parseExitIp(""), "");
  assert.equal(parseExitIp("no ip line here"), "", "没有 ip= 行必须是空串，不能瞎猜");
});

test("revive：labelExits 汇总各节点出口，全同则告警（真机教训：N 设备折叠成一个共享出口）", async () => {
  const logs = [];
  const same = await labelExits({ ports: [10801, 10802], fetchImpl: async () => ({ ok: true, text: async () => "ip=104.28.243.105\n" }), log: (m) => logs.push(m) });
  assert.deepEqual(same, [{ ip: "104.28.243.105", nodes: [10801, 10802] }]);
  assert.ok(logs.some((l) => l.includes("出口不分散")), "全同必须告警");

});

test("revive：labelExits 取证失败不算错（不影响节点进池），只记数", async () => {
  const logs = [];
  const g = await labelExits({ ports: [10801, 10802], fetchImpl: async () => { throw new Error("boom"); }, log: (m) => logs.push(m) });
  assert.deepEqual(g, []);
  assert.ok(logs.some((l) => l.includes("出口取证失败")));
});
