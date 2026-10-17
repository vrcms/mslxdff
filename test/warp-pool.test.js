// warp-pool 离线测试：不触网、不起隧道进程、不真等待（sleep/wait 全部注入）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

import { generateWgKeyPair, isWgKey } from "../src/warp-pool/keys.js";
import { DEFAULTS, resolveWarpConfig } from "../src/warp-pool/config.js";
import { loadNode, loadNodes, nodePaths, renderWireproxyConf, saveNode } from "../src/warp-pool/nodes.js";
import { backoffMs, buildRegisterBody, parseRegisterResponse, registerWarpDevice } from "../src/warp-pool/register.js";
import { createSelector } from "../src/warp-pool/strategy.js";
import { createRotatingDispatcher, headerValue, tapHandler } from "../src/warp-pool/rotate.js";
import { classifyWarpSignal } from "../src/warp-pool/verdict.js";
import { createHealthMonitor } from "../src/warp-pool/health.js";
import { parseExitIp, createReviver, labelExits, tailReason } from "../src/warp-pool/revive.js";
import { createWarpDispatcher, createWarpPool, redialPlan } from "../src/warp-pool/index.js";
import { createIdentityRotator, readExitIp, wireRotation } from "../src/warp-pool/identity.js";
import { writeTunnelConf } from "../src/warp-pool/wireproxy.js";
import { isOurWireproxy, parseCmdline, portInUse, reclaimPort, waitPortFree } from "../src/warp-pool/ports.js";
import { fmtExit, fmtExits, fmtHealth, fmtHeartbeat, fmtIdentityDetail, fmtPool, fmtPoolEmpty, fmtProbe, fmtProbeGiveUp, fmtPortBlocked, fmtReclaim, fmtSiblings, startupReport } from "../src/warp-pool/report.js";

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

test("config：缺省开 + leader 才建池；显式关可退；轮换缺省开", () => {
  const def = resolveWarpConfig({}, { logDirFn });
  assert.equal(def.enabled, true, "缺省开：429 时换身份换出口是缺省行为");
  assert.equal(def.active, true, "缺省 leader ⇒ 建池");
  assert.equal(def.rotate, true, "缺省开轮换（换身份＝换桶）");
  assert.equal(resolveWarpConfig({ MSLXDFF_WARP_POOL: "0" }, { logDirFn }).active, false, "显式关必须生效");
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

test("revive：首次退出立即复活；复活后有稳定期（防「起一条死一条」刷屏），失败按 30s→10min 退避", async () => {
  let t = 1_000_000;
  const calls = [];
  const armed = [];
  const r = createReviver({
    revive: async (p) => (calls.push(p), true),
    isAlive: () => true,
    now: () => t,
    sleep: async () => {},
    schedule: (fn, ms) => (armed.push([fn, ms]), { unref() {} }),
    minGapMs: 30_000,
    maxGapMs: 600_000,
  });
  assert.equal(await r.onExit(10800), true, "首次必须立即复活");
  assert.deepEqual(calls, [10800]);
  assert.equal(await r.onExit(10800), false, "稳定期内的再退出先等一轮，不再立刻重启");
  assert.deepEqual(armed.map((a) => a[1]), [30_000], "必须自己安排下一次重试，不能只打印「下次最早 Ns 后」");

  const r2 = createReviver({ revive: async () => false, now: () => t, sleep: async () => {}, settleMs: 0, schedule: () => ({ unref() {} }), minGapMs: 30_000, maxGapMs: 600_000 });
  assert.equal(await r2.onExit(10801), false);
  assert.equal(await r2.onExit(10801), false, "退避窗口内不重复尝试");
  t += 30_000;
  assert.equal(await r2.onExit(10801), false, "满 30s 后再试一次");
  assert.equal(r2.stats()[0].attempts, 2);
  t += 60_000;
  await r2.onExit(10801);
  assert.equal(r2.stats()[0].attempts, 3, "退避按 30s→60s→… 递增");

  const r3 = createReviver({ revive: async () => false, now: () => t, sleep: async () => {}, settleMs: 0, schedule: () => ({ unref() {} }), log: () => {} });
  await r3.onExit(10802);
  r3.stop();
  assert.deepEqual(r3.stats(), [], "stop() 必须清账（池关闭后不许再有复活动作）");
});

test("revive：复活后被 isAlive 逮到「立刻又退出」⇒ 不认成功（真机教训：spawn 成功 ≠ 隧道活下来）", async () => {
  const logs = [];
  let t = 0;
  const r = createReviver({
    revive: async () => true,
    isAlive: () => false,
    settleMs: 1_200,
    sleep: async () => {},
    now: () => t,
    schedule: () => ({ unref() {} }),
    minGapMs: 30_000,
    log: (m) => logs.push(m),
  });
  assert.equal(await r.onExit(10800), false, "不许拿「spawn 被调用了」冒充「活下来了」");
  assert.ok(logs.some((l) => l.includes("立刻又退出")), "必须把「又退出」说清楚，否则人只会看到一片「已复活」");
  assert.equal(r.stats()[0].attempts, 1);
  t += 1;
  assert.equal(await r.onExit(10800), false, "紧接着再退出必须走退避，不许立刻再来一轮");
  assert.equal(r.stats()[0].attempts, 1, "退避窗口内的那次不算尝试");
});

test("revive：settleMs 后真的活着才算复活成功；失败的尝试要累计", async () => {
  let t = 0;
  let alive = true;
  const r = createReviver({ revive: async () => true, isAlive: () => alive, settleMs: 1_200, sleep: async () => {}, now: () => t, schedule: () => ({ unref() {} }), minGapMs: 30_000, log: () => {} });
  assert.equal(await r.onExit(10800), true);
  assert.equal(r.stats()[0].attempts, 0, "成功即清账");
  alive = false;
  t += 31_000;
  assert.equal(await r.onExit(10800), false);
  assert.equal(r.stats()[0].attempts, 1, "失败的尝试必须累计，退避才会涨");
});

test("revive：tailReason 取子进程末行当退出原因（wireproxy 的报错都在 stderr）", () => {
  assert.equal(tailReason("2026/10/16 listen tcp 127.0.0.1:10801: bind: address already in use\n"), "2026/10/16 listen tcp 127.0.0.1:10801: bind: address already in use");
  assert.equal(tailReason("\n \n"), "");
  assert.equal(tailReason(""), "");
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

// ---------- identity（429 → 换身份换出口） ----------

test("identity：readExitIp 只认 ip= 行，取不到返回空串（绝不抛）", async () => {
  const ok = await readExitIp({ port: 1, fetchImpl: async () => ({ ok: true, text: async () => "fl=1\nip=104.28.1.2\nts=1\n" }) });
  assert.equal(ok, "104.28.1.2");
  assert.equal(await readExitIp({ port: 1, fetchImpl: async () => { throw new Error("boom"); } }), "");
});

test("identity：轮换必须实测确认出口变了——没变就重跑整个 cycle", async () => {
  const reads = ["1.1.1.1", "1.1.1.1", "9.9.9.9"];
  const applied = [];
  const r = createIdentityRotator({
    register: async () => ({ privateKey: "P=" }),
    apply: async (n) => applied.push(n.port),
    readIp: async () => reads.shift() ?? "9.9.9.9",
    sleep: async () => {},
    log: () => {},
  });
  r.note(10800, "1.1.1.1");
  assert.deepEqual(await r.rotate(10800, { force: true }), { ok: true, ip: "9.9.9.9", attempts: 3 });
  assert.equal(applied.length, 3, "每次都重新落盘 + 起隧道");
  assert.equal(r.ipOf(10800), "9.9.9.9");
});

test("identity：出口始终没变 ⇒ 明确失败，且不得抹掉已知出口；minGapMs 掐住重复轮换", async () => {
  let t = 1000;
  const r = createIdentityRotator({
    register: async () => ({ privateKey: "P=" }),
    apply: async () => {},
    readIp: async () => "2.2.2.2",
    sleep: async () => {},
    maxAttempts: 2,
    now: () => t,
    log: () => {},
  });
  r.note(10801, "2.2.2.2");
  assert.equal((await r.rotate(10801, { force: true })).ok, false);
  assert.equal(r.ipOf(10801), "2.2.2.2", "失败不得抹掉已知出口");
  assert.equal((await r.rotate(10801, { minGapMs: 60_000 })).skipped, true, "刚轮换过 ⇒ 掐住（防把 CF 刷黑）");
  t += 61_000;
  assert.equal((await r.rotate(10801, { minGapMs: 60_000 })).skipped, undefined, "过了最小间隔放行");
});

test("identity：同端口并发轮换去重（429 风暴里 N 个失败请求只换一次身份）", async () => {
  let calls = 0;
  const r = createIdentityRotator({
    register: async () => { calls += 1; return { privateKey: "P=" }; },
    apply: async () => {},
    readIp: async () => `9.9.9.${calls}`,
    sleep: async () => {},
    log: () => {},
  });
  r.note(10802, "0.0.0.0");
  const [a, b] = await Promise.all([r.rotate(10802, { force: true }), r.rotate(10802, { force: true })]);
  assert.equal(calls, 1, "在途轮换必须去重");
  assert.equal(a, b, "后来者拿到同一个 Promise");
  assert.equal(r.busy(10802), false, "轮换结束必须解除 busy");
});

test("identity：noteExits 批量记账；wireRotation 轮换期间先冷却、换好放回", async () => {
  const marks = [];
  const tunnels = new Map([[10803, { stop: () => marks.push("stop") }]]);
  const rot = wireRotation({
    dispatcher: { entries: () => [{ index: 0, port: 10803 }], markFailure: (i) => marks.push(`fail${i}`), markOk: (i) => marks.push(`ok${i}`) },
    register: async () => ({ privateKey: "P=" }),
    tunnels,
    bringUp: async (n) => marks.push(`up${n.port}`),
    swap: (p, n) => marks.push(`swap${p}:${n.port}`),
    log: () => {},
    readIp: async () => "9.9.9.9",
    sleep: async () => {},
  });
  rot.noteExits([{ ip: "104.28.1.1", nodes: [10803, 10804] }, { ip: "104.28.1.2", nodes: [10805] }]);
  assert.equal(rot.ipOf(10804), "104.28.1.1");
  assert.equal(rot.ipOf(10805), "104.28.1.2");
  assert.equal(rot.stats().length, 3);
  assert.equal((await rot.rotate(10803, { force: true })).ok, true);
  assert.deepEqual(marks, ["fail0", "stop", "swap10803:10803", "up10803", "ok0"], "先冷却 → 停旧 → 换盘 → 起新 → 放回");
  assert.equal(tunnels.has(10803), false, "旧隧道已从表里摘掉");
});

test("rotate：tapHandler 把 403/429 连正文一起交出去（判决要看具名判决），其余方法原样转发", () => {
  const seen = [];
  const orig = { onHeaders: (s) => s, onData: () => "d", onComplete: () => "c" };
  const h = tapHandler(orig, (s) => seen.push(s));
  assert.equal(h.onHeaders(429, [], () => {}, "Too Many Requests"), 429, "返回值必须透传");
  assert.equal(h.onData("x"), "d", "onData 返回值必须透传（正文只旁听不消费）");
  assert.equal(h.onComplete(), "c");
  assert.deepEqual(seen, [{ status: 429, text: "x" }], "429 必须等正文到手：BlackUsageLimitError 与 FreeUsageLimitError 同是 429，只能靠正文区分");
  assert.equal(tapHandler(orig, null), orig, "没有 tap 必须原样返回");

  const early = [];
  const h2 = tapHandler({ onHeaders: () => {}, onData: () => {}, onComplete: () => {} }, (s) => early.push(s));
  h2.onHeaders(403, [], () => {});
  assert.deepEqual(early, [], "正文还没到不许提前判");
  h2.onData(Buffer.from('{"error":{"type":"FreeTierError"}}'));
  assert.equal(early.length, 1, "具名判决一到手就判，不必等 onComplete");
  assert.match(early[0].text, /FreeTierError/);

  const other = [];
  const h3 = tapHandler({ onHeaders: () => {}, onData: () => {}, onComplete: () => {} }, (s) => other.push(s));
  h3.onHeaders(200, [], () => {});
  assert.deepEqual(other, [{ status: 200, text: "" }], "非 403/429 照旧在 onHeaders 回调，不占正文缓冲");

  const events = [];
  const d = createRotatingDispatcher({
    nodes: [{ port: 10800, uri: "http://127.0.0.1:10800" }],
    agentFactory: (uri) => ({ uri, dispatch: (o, handler) => { handler.onHeaders(429); return true; }, close: async () => {} }),
    fallbackAgent: { dispatch: () => true, close: async () => {} },
    onStatus: (signal, port) => events.push([signal.status, port]),
  });
  d.dispatch({ headers: [] }, { onHeaders: () => "ok" });
  assert.deepEqual(events, [[429, 10800]], "429 必须连同端口号报给轮换器（否则不知道该换哪台设备）；该 handler 没有 onData ⇒ 退回只按状态码判决");
});

// ---------- ports（端口占用 / 上一代残留进程） ----------

test("ports：只认「正在跑我们自己那条 conf」的 wireproxy——判据收紧，绝不误杀别人的进程", () => {
  const conf = "/root/.config/mslxdff/warp-pool/node-10801.conf";
  assert.equal(isOurWireproxy(["wireproxy", "-c", conf], conf), true);
  assert.equal(isOurWireproxy(["/usr/local/bin/wireproxy", "-c", conf], conf), true);
  assert.equal(isOurWireproxy(["wireproxy", "-c", "/tmp/other.conf"], conf), false, "conf 不是我们的 ⇒ 不许动");
  assert.equal(isOurWireproxy(["/usr/bin/sshd", "-c", conf], conf), false, "可执行文件不是 wireproxy ⇒ 不许动");
  assert.equal(isOurWireproxy([], conf), false);
  assert.equal(isOurWireproxy(null, conf), false);
});

test("ports：parseCmdline 切 NUL 分隔的 /proc/<pid>/cmdline", () => {
  assert.deepEqual(parseCmdline("wireproxy\0-c\0/a/node-1.conf\0"), ["wireproxy", "-c", "/a/node-1.conf"]);
  assert.deepEqual(parseCmdline(""), []);
  assert.deepEqual(parseCmdline(null), []);
});

test("ports：reclaimPort 只清自家残留、先礼后兵（SIGTERM 足够就不 SIGKILL）；非 linux 一律不动手", async () => {
  const conf = nodePaths("/w", 10802).conf; // 用被测代码同一套拼路径（Windows 上是反斜杠，Linux 是斜杠）
  const argv = {
    11: ["wireproxy", "-c", conf],
    12: ["wireproxy", "-c", nodePaths("/w", 9999).conf],
    13: ["/sbin/init", "-c", conf],
  };
  const killed = [];
  const dead = new Set();
  const common = {
    dir: "/w",
    port: 10802,
    platform: "linux",
    pids: () => [11, 12, 13],
    cmdline: (p) => argv[p],
    kill: (pid, sig) => {
      if (sig === 0) {
        if (dead.has(pid)) throw new Error("gone");
        return;
      }
      killed.push([pid, sig]);
      dead.add(pid);
    },
    sleep: async () => {},
    log: () => {},
  };
  const r1 = await reclaimPort(common);
  assert.deepEqual(r1.killed, [11], "只挑出跑本池 conf 的那条残留");
  assert.deepEqual(killed, [[11, "SIGTERM"]], "SIGTERM 就死了就不必 SIGKILL");
  assert.deepEqual((await reclaimPort({ ...common, platform: "win32" })).killed, [], "非 linux 直接放弃（不猜别人的端口）");
});

test("ports：僵尸算已死、另一个 daemon 的活隧道不许清（七次修订：两个 daemon 互杀的根因）", async () => {
  const conf = nodePaths("/w", 10803).conf;
  const argv = {
    21: ["wireproxy", "-c", conf],
    22: ["wireproxy", "-c", conf],
    23: ["wireproxy", "-c", conf],
    999: ["/usr/bin/node", "/g/mslxdff/bin/mslxdff.js", "--daemon"],
  };
  const st = { 21: { state: "Z", ppid: 1, startTicks: 0 }, 22: { state: "S", ppid: 999, startTicks: 0 }, 23: { state: "S", ppid: 1, startTicks: 0 } };
  const killed = [];
  const dead = new Set();
  const logs = [];
  const r = await reclaimPort({
    dir: "/w",
    port: 10803,
    platform: "linux",
    pids: () => [21, 22, 23],
    cmdline: (p) => argv[p],
    stat: (p) => st[p],
    kill: (pid, sig) => {
      if (sig === 0) {
        if (dead.has(pid)) throw new Error("gone");
        return;
      }
      killed.push([pid, sig]);
      dead.add(pid);
    },
    sleep: async () => {},
    log: (m) => logs.push(m),
  });
  assert.deepEqual(r.zombies, [21], "僵尸（state=Z）算已死：kill 对它无效，也不是真占用者");
  assert.deepEqual(r.foreign.map((f) => [f.pid, f.ppid]), [[22, 999]], "父进程是另一个活 daemon ⇒ 别人的活隧道，不许清");
  assert.deepEqual(r.killed, [23], "只剩真孤儿被清");
  assert.deepEqual(killed, [[23, "SIGTERM"]], "绝不对僵尸和别人的活隧道发信号");
  assert.equal(r.gone, true);
  assert.ok(logs.some((l) => l.includes("另一个 daemon(pid 999")), "日志必须点名是哪个 daemon 占着（否则又只能猜）");
});

function fakeSocket(mode) {
  return {
    setTimeout: (ms, fn) => {
      if (mode === "timeout") setTimeout(fn, 0);
    },
    destroy: () => {},
    once: (evt, fn) => {
      if (evt === mode) setTimeout(fn, 0);
      return undefined;
    },
  };
}

test("ports：portInUse 连得上=占用 / 被拒或超时=空闲（起隧道前的守卫，据此拒绝硬起）", async () => {
  assert.equal(await portInUse(1, { connectFn: () => fakeSocket("connect") }), true);
  assert.equal(await portInUse(1, { connectFn: () => fakeSocket("error") }), false);
  assert.equal(await portInUse(1, { connectFn: () => fakeSocket("timeout"), timeoutMs: 5 }), false, "连不上也不能把启动卡住");
});

test("index：端口被别的进程占着 ⇒ 拒绝起隧道（硬起只会 bind 失败 + 无限重启刷屏）", async () => {
  const dir = tmp();
  const started = [];
  const logs = [];
  const srv = createServer();
  await new Promise((r) => srv.listen(10960, "127.0.0.1", r));
  try {
    const pool = createWarpPool({
      env: { MSLXDFF_WARP_POOL: "1", MSLXDFF_WARP_DIR: dir, MSLXDFF_WARP_COUNT: "1", MSLXDFF_WARP_BASE_PORT: "10960" },
      log: (m) => logs.push(m),
      ensureBin: async () => "C:/fake/wireproxy",
      register: async () => ({ id: "id", token: "tk", v4: "172.16.0.2", v6: "2606:4700::e", peerKey: "PK=", endpoint: "e:2408", privateKey: "PRIVKEY=" }),
      start: ({ port }) => {
        started.push(port);
        return { port, stop() {} };
      },
      probe: async () => ({ ok: true, status: 200 }),
      wait: async () => {},
      rnd: () => 0,
      reclaim: async () => [],
      waitFree: (port, opts) => waitPortFree(port, { ...opts, rounds: 2, stepMs: 5 }),
    });
    await pool.ready;
    assert.deepEqual(started, [], "端口被占 ⇒ 一条隧道都不许起");
    assert.ok(logs.some((l) => l.includes("拒绝再起") && l.includes("占着")), "必须说清是谁占着、为什么不硬起");
    assert.equal(pool.stats().tunnels, 0);
    await pool.close();
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

// ---------- 二次真机修复（2026-10-16 深夜）：清残留 / 等端口释放 / 探活闸门 / 日志不刷屏 ----------

test("ports：waitPortFree 等端口真正释放（SIGTERM 之后套接字要几百 ms 才走，这期间连得上不算被占）", async () => {
  const seq = [true, true, false];
  let i = 0;
  assert.equal(await waitPortFree(10800, { inUse: async () => seq[Math.min(i++, seq.length - 1)], sleep: async () => {} }), true, "占用消退后必须放行");
  assert.equal(await waitPortFree(10800, { inUse: async () => true, sleep: async () => {}, rounds: 3 }), false, "始终被占必须判否");
});

test("index：清残留紧挨在起隧道之前、每端口各一次（绝不在自己管着时清，否则会杀掉自己的隧道）", async () => {
  const dir = tmp();
  const order = [];
  const pool = createWarpPool({
    env: { MSLXDFF_WARP_POOL: "1", MSLXDFF_WARP_DIR: dir, MSLXDFF_WARP_COUNT: "2", MSLXDFF_WARP_BASE_PORT: "10945" },
    log: () => {},
    ensureBin: async () => "C:/fake/wireproxy",
    register: async () => ({ id: "id", token: "tk", v4: "172.16.0.2", v6: "2606:4700::f", peerKey: "PK=", endpoint: "e:2408", privateKey: "PRIVKEY=" }),
    reclaim: async ({ port }) => {
      order.push(`reclaim${port}`);
      return [];
    },
    inUse: async () => false,
    waitFree: async () => true,
    start: ({ port }) => {
      order.push(`start${port}`);
      return { port, stop() {} };
    },
    probe: async () => ({ ok: true, status: 200 }),
    wait: async () => {},
    rnd: () => 0,
  });
  await pool.ready;
  assert.deepEqual(order, ["reclaim10945", "start10945", "reclaim10946", "start10946"], "每端口只清一次，且紧接 spawn");
  await pool.close();
});

test("index：探活闸门先等握手、不通再探一次（真机：一起来就探 ⇒ 4 条全没通 ⇒ 池为空、WARP 白开）", async () => {
  const dir = tmp();
  const waits = [];
  let probes = 0;
  const pool = createWarpPool({
    env: { MSLXDFF_WARP_POOL: "1", MSLXDFF_WARP_DIR: dir, MSLXDFF_WARP_COUNT: "1", MSLXDFF_WARP_BASE_PORT: "10955" },
    log: () => {},
    ensureBin: async () => "C:/fake/wireproxy",
    register: async () => ({ id: "id", token: "tk", v4: "172.16.0.2", v6: "2606:4700::9", peerKey: "PK=", endpoint: "e:2408", privateKey: "PRIVKEY=" }),
    reclaim: async () => [],
    inUse: async () => false,
    waitFree: async () => true,
    start: ({ port }) => ({ port, stop() {} }),
    probe: async () => {
      probes += 1;
      return probes >= 2 ? { ok: true, status: 200 } : { ok: false, status: 0, error: "handshake timeout" };
    },
    wait: async (ms) => waits.push(ms),
    rnd: () => 0,
  });
  await pool.ready;
  assert.equal(probes, 2, "第一次探不通必须再探一次");
  assert.ok(waits.filter((ms) => ms === 2_000).length >= 2, "起隧道后先等握手，重试前还要再等一次");
  assert.equal(pool.stats().nodes.length, 1, "第二次探通 ⇒ 进池");
  await pool.close();
});

test("rotate：markFailure 只在第 1 次与整十次报（健康探活每分钟一轮，不刷日志）", () => {
  const logs = [];
  const d = createRotatingDispatcher({
    nodes: [{ port: 10800, uri: "http://127.0.0.1:10800" }],
    agentFactory: () => ({ dispatch: () => true, close: async () => {} }),
    log: (m) => logs.push(m),
  });
  for (let i = 0; i < 12; i++) d.markFailure(0);
  assert.equal(logs.length, 2, "12 次失败只报 2 行（第 1 次 + 第 10 次）");
  assert.equal(d.stats()[0].fails, 12, "计数照旧累计");
});

// ---------- report（日志契约：能定位问题才算合格——这是四轮返工换来的教训） ----------

test("report：启动自检块一次说清配置/目录/身份/端口占用者（第 1 轮返工就是缺这块）", async () => {
  const logs = [];
  const cfg = { enabled: true, mode: "leader", ports: [10800, 10801], strategy: "session", rotate: true, cooldownMs: 600_000, dir: "/w" };
  const nodes = [{ port: 10800, id: "a", token: "b", privateKey: "c" }];
  const owners = {
    10800: { busy: true, ours: [1555182], others: [] },
    10801: { busy: true, ours: [], others: [{ pid: 988, name: "sshd" }] },
  };
  await startupReport({ cfg, nodes, binPath: "/w/bin/wireproxy", binSize: 3_400_000, ownerOf: async (p) => owners[p], log: (m) => logs.push(m) });
  const all = logs.join("\n");
  assert.match(all, /启动自检：开关=开 模式=leader 端口=10800,10801/);
  assert.match(all, /身份文件 1\/2：:10800 ✓ :10801 ✗缺/);
  assert.match(all, /:10800 被 pid 1555182 占：本池 wireproxy 残留/);
  assert.match(all, /:10801 被 pid 988 sshd 占：非本池进程/);
  assert.match(all, /有 1 个端口被本池残留占着/);
});

test("report：隧道退出行必须能判出「谁杀的」（信号=外部终止 vs 自行退出）与 stderr 末行", () => {
  const ext = fmtExit({ port: 10803, code: null, signal: "SIGTERM", pid: 2528532, aliveMs: 400, tail: "bind: address already in use" });
  assert.match(ext, /信号 SIGTERM/);
  assert.match(ext, /存活 400ms/);
  assert.match(ext, /外部终止/);
  assert.match(ext, /末行="bind: address already in use"/);
  const self = fmtExit({ port: 10800, code: 1, signal: null, pid: 1, aliveMs: 2000, tail: "" });
  assert.match(self, /退出码 1/);
  assert.match(self, /进程自行退出/);
  assert.match(self, /末行="没有输出"/);
});

test("report：探活行带 URL/耗时/错误原文；放弃行给自检命令", () => {
  const ok = fmtProbe({ port: 10801, attempt: 2, attempts: 2, url: "https://opencode.ai/zen/v1/models", ok: true, status: 200, ms: 1800 });
  assert.match(ok, /探活 2\/2/);
  assert.match(ok, /HTTP 200（1\.8s）→ 进池/);
  const bad = fmtProbe({ port: 10801, attempt: 1, attempts: 2, url: "u", ok: false, status: 0, error: "connect ECONNREFUSED", ms: 12 });
  assert.match(bad, /错误=connect ECONNREFUSED/);
  assert.match(fmtProbeGiveUp({ port: 10801, attempts: 2, url: "u" }), /自检：curl --proxy http:\/\/127\.0\.0\.1:10801 u/);
});

test("report：池结论一行给全（入池数 + 每端口出口 + 不同地址数）；池空给逐条自检", () => {
  const pool = fmtPool({ pooled: 2, total: 4, exits: [{ ip: "104.28.1.1", nodes: [10800, 10801] }] });
  assert.match(pool, /出口池就绪：2\/4 条入池/);
  assert.match(pool, /:10800=104\.28\.1\.1 :10801=104\.28\.1\.1/);
  assert.match(pool, /不同地址 1 个/);
  assert.match(fmtPoolEmpty({ total: 4, ports: [10800, 10801] }), /池为空/);
  assert.match(fmtPoolEmpty({ total: 4, ports: [10800, 10801] }), /逐条自检/);
});

test("report：健康行把每个不通节点的状态/错误/耗时/第几次/冷却都报全；心跳一行给状态", () => {
  assert.match(fmtHealth({ healthy: 4, total: 4, slowestMs: 1900 }), /健康检查：4\/4 通（最慢 1\.9s）/);
  const bad = fmtHealth({ healthy: 3, total: 4, slowestMs: 900, problems: [{ port: 10802, status: 0, error: "ETIMEDOUT", ms: 800, fails: 4, cooldownMs: 600_000 }] });
  assert.match(bad, /:10802 第 4 次不通（HTTP 0 ETIMEDOUT，800ms）冷却 600s/);
  const hb = fmtHeartbeat({ alive: 4, total: 4, pooled: 4, exits: [{ port: 10800, ip: "104.28.1.1" }], cooling: 0, lastAllDown: "08:20:11" });
  assert.match(hb, /隧道 4\/4 活｜入池 4｜出口 1 种（104\.28\.1\.1）｜冷却中 0｜全池不通 08:20:11/);
});

test("report：清理行报扫了多少进程/命中谁/等了多久；端口被占行报出是谁", () => {
  assert.match(fmtReclaim({ port: 10801, scanned: 132, killed: [], waitedMs: 0 }), /扫 132 个进程；无本池残留/);
  assert.match(fmtReclaim({ port: 10801, scanned: 132, killed: [1555182, 2528532], waitedMs: 320, gone: true }), /命中本池残留 pid 1555182,2528532 → 已清掉（等了 320ms）/);
  assert.match(fmtPortBlocked({ port: 10802, ours: [], others: [{ pid: 988, name: "sshd" }] }), /端口被 pid 988 sshd 占着，拒绝再起/);
});

test("report：同机另一个 daemon 必须一次说清（pid/父进程/已运行多久 + 精确 kill 命令）——七次修订的核心补课", () => {
  const sib = fmtSiblings({ list: [{ pid: 1558055, ppid: 1, state: "S", aliveSec: 22320 }] });
  assert.match(sib, /同机还有 1 个别的 mslxdff daemon 在跑/);
  assert.match(sib, /pid 1558055（父 1，已运行 6h12m）/);
  assert.match(sib, /先停掉它：kill 1558055/);
  assert.equal(fmtSiblings({ list: [] }), "", "没有别的 daemon 就别刷一行");
  const blocked = fmtPortBlocked({ port: 10803, foreign: [{ pid: 22, ppid: 1558055, aliveSec: 60 }] });
  assert.match(blocked, /另一个 daemon\(pid 1558055，已运行 1m\) 的活隧道 pid 22/);
  assert.match(blocked, /先停掉那个 daemon：kill 1558055/);
});

test("report：启动自检发现端口被另一个 daemon 占着 ⇒ 必须单独大声报（两个 daemon 互杀的根因读数）", async () => {
  const logs = [];
  const cfg = { enabled: true, mode: "leader", ports: [10800], strategy: "session", rotate: true, cooldownMs: 600_000, dir: "/w" };
  await startupReport({ cfg, nodes: [], binPath: "/w/bin/wireproxy", binSize: 0, ownerOf: async () => ({ busy: true, ours: [], zombies: [], foreign: [{ pid: 22, ppid: 1558055, aliveSec: 22320 }], others: [] }), log: (m) => logs.push(m) });
  const all = logs.join("\n");
  assert.match(all, /另一个 daemon\(pid 1558055，已运行 6h12m\) 的活隧道 pid 22 占着/);
  assert.match(all, /那不是残留，本进程不碰它（清了就是互杀）/);
  assert.match(all, /kill 1558055/);
});

test("report：身份指纹必须能判「设备写重复」还是「CF 共享 NAT 折叠」——真机 4 条隧道只拿到 2 个出口", () => {
  const same = fmtIdentityDetail([
    { port: 10800, id: "aaaa1111bbbb", v4: "172.16.0.2", endpoint: "162.159.192.1:2408", registeredAt: "2026-10-16T10:00:00.000Z" },
    { port: 10801, id: "aaaa1111bbbb", v4: "172.16.0.2", endpoint: "162.159.192.1:2408", registeredAt: "2026-10-16T10:00:00.000Z" },
  ]).join("\n");
  assert.match(same, /:10800 设备=aaaa1111 内网=172\.16\.0\.2 端点=162\.159\.192\.1:2408 注册=2026-10-16T10:00:00/);
  assert.match(same, /设备 id 重复：aaaa1111 ← :10800,:10801/);
  assert.match(same, /WARP 内网地址重复：172\.16\.0\.2 ← :10800,:10801/);
  const distinct = fmtIdentityDetail([
    { port: 10800, id: "aaaa1111", v4: "172.16.0.2", endpoint: "e", registeredAt: "t" },
    { port: 10801, id: "bbbb2222", v4: "172.16.0.3", endpoint: "e", registeredAt: "t" },
  ]).join("\n");
  assert.doesNotMatch(distinct, /重复/, "设备各不相同就不许报重复（此时出口相同只能是 CF 的 NAT 折叠）");
});

test("report：出口分散结论必须自洽（隧道数 ≠ 名额数）并给出下一步命令——旧措辞「同时在线就有 N 份名额」与共享 NAT 自相矛盾", () => {
  const two = fmtExits({
    groups: [{ ip: "104.28.243.105", nodes: [10800, 10802, 10803] }, { ip: "104.28.211.105", nodes: [10801] }],
    dir: "/root/.config/mslxdff/warp-pool",
  });
  assert.match(two, /出口分散：2 个出口地址 \/ 4 条隧道在线/);
  assert.match(two, /隧道数 ≠ 名额数：免费版 WARP 的 IPv4 是共享 NAT/);
  assert.match(two, /撞车：104\.28\.243\.105 ← :10800,:10802,:10803/);
  assert.match(two, /rm -f \/root\/\.config\/mslxdff\/warp-pool\/node-10802\.json \/root\/\.config\/mslxdff\/warp-pool\/node-10803\.json && mslxdff -restart/);
  assert.equal(fmtExits({ groups: [] }), "", "没有取证结果就别刷一行");
});

test("verdict：判决表逐字对齐 zen-router（403 FreeTierError 与 429 FreeUsage 同判、Black 绝不换、裸 429 换、其他 403 不换）", () => {
  const ft = classifyWarpSignal({ status: 403, text: '{"error":{"type":"FreeTierError","message":"free tier can only be used from within OpenCode"}}' });
  assert.equal(ft.kind, "free-tier");
  assert.equal(ft.rotate, true);
  assert.equal(ft.forced, true, "必须强制：参照实现记录过「冷却把第一次真实反应吞掉」的 bug");
  assert.equal(classifyWarpSignal({ status: 429, text: '{"error":{"type":"FreeUsageLimitError"}}' }).kind, "free-quota");
  assert.equal(classifyWarpSignal({ status: 429, text: '{"error":{"type":"GoUsageLimitError"}}' }).forced, true);
  const black = classifyWarpSignal({ status: 429, text: '{"error":{"type":"BlackUsageLimitError"}}' });
  assert.equal(black.kind, "black-quota");
  assert.equal(black.rotate, false, "账号日配额：换出口抬不动，参照实现绝不旋转");
  const bare = classifyWarpSignal({ status: 429, text: "" });
  assert.equal(bare.kind, "ip-limit", "读不到正文的裸 429 按 IP 限流处理（kindByStatus）");
  assert.equal(bare.forced, false, "裸 429 保留冷却，防 429 风暴把 CF 注册刷爆");
  assert.equal(classifyWarpSignal({ status: 403, text: "forbidden by region" }).rotate, false, "没有 FreeTier 判决的 403 不是配额信号");
  assert.equal(classifyWarpSignal({ status: 200, text: "FreeTierError" }).rotate, false, "非 403/429 一律不参与判决");
  assert.match(classifyWarpSignal({ status: 403, text: "" }).why, /换出口无用/);
});
