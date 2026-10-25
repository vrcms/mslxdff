// multi-ip-pool 回归（零真机依赖：IO 全部注入；非 Linux 只验"诚实跳过"）。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMultiIpConfig, resolveRole, devNameFor, tableFor } from "../src/multi-ip-pool/config.js";
import { parseVpnGateCsv, decodeConfig, parseRemote, candidateNodes, matchCountry, loadNodeCache, saveNodeCache, writeAuthFile, fetchNodes, probeExitIp } from "../src/multi-ip-pool/nodes.js";
import { buildOpenvpnArgs, parseTunAddr, tunnelUpCommands, tunnelDownCommands, rulePriorityFor, isSupportedPlatform, startTunnel, waitTunAddr, relaxRpf, bringUpTunnel } from "../src/multi-ip-pool/tunnel.js";
import { createMultiIpDispatcher } from "../src/multi-ip-pool/dispatch.js";
import { createMultiIpPool } from "../src/multi-ip-pool/index.js";

const CONF = "client\ndev tun\nproto udp\nremote 203.0.113.9 1194\ncipher AES-128-CBC\n";
const B64 = Buffer.from(CONF, "utf8").toString("base64");
const rowOf = (over = {}) => ({ hostName: "vpn000.vpngate.net", ip: "203.0.113.9", score: 2_000_000, ping: 20, speed: 1, countryLong: "Japan", countryShort: "JP", sessions: 1, uptime: 1, totalUsers: 1, totalTraffic: 1, logType: "2weeks", operator: "AS1", message: "", config: B64, ...over });

function fakeAgent(addr) {
  return { addr, dispatched: [], dispatch(opts) { this.dispatched.push(opts); return { ok: true }; }, async close() {} };
}

/** 假 openvpn 子进程：EventEmitter + stdout/stderr/kill（startTunnel 只依赖这几样）。 */
function fakeChild({ ready = true, exitCode = null, pid = 4242 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; return true; };
  setImmediate(() => {
    if (ready) child.stderr.emit("data", Buffer.from("Wed Oct 22 12:00:00 Initialization Sequence Completed\n"));
    if (exitCode !== null) child.emit("exit", exitCode, null);
  });
  return child;
}

test("config: 缺省开/角色 auto/国家与表号解析", () => {
  const cfg = resolveMultiIpConfig({}, { logDirFn: () => "C:/logs" });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.mode, "auto");
  assert.equal(cfg.count, 2);
  assert.deepEqual(cfg.countries, []);
  assert.equal(cfg.dir, join("C:/logs", "multi-ip-pool"));
  assert.equal(cfg.sysctl, true);
  const cfg2 = resolveMultiIpConfig({ MSLXDFF_MULTI_IP_POOL: "0", MSLXDFF_MULTI_IP_COUNT: "5", MSLXDFF_MULTI_IP_COUNTRY: "jp, kr", MSLXDFF_MULTI_IP_SYSCTL: "0" }, { logDirFn: () => "C:/logs" });
  assert.equal(cfg2.enabled, false);
  assert.equal(cfg2.count, 5);
  assert.deepEqual(cfg2.countries, ["JP", "KR"]);
  assert.equal(cfg2.sysctl, false);
  assert.equal(devNameFor("mltun", 3), "mltun3");
  assert.equal(tableFor(210, 3), 213);
  assert.equal(rulePriorityFor(0), 20000);
});

test("config: 角色门 auto（**只有组长**建池：组员与单机都不建）", () => {
  assert.equal(resolveRole({ mode: "auto", joined: [] }).role, "solo");
  assert.equal(resolveRole({ mode: "auto", joined: [] }).active, false, "用户 2026-10-25：只有组长启用，单机不再建池");
  assert.equal(resolveRole({ mode: "auto", joined: [{ name: "g", leaderUrl: "" }] }).role, "leader");
  assert.equal(resolveRole({ mode: "auto", joined: [{ name: "g", leaderUrl: "" }] }).active, true);
  assert.equal(resolveRole({ mode: "auto", joined: [{ name: "g", leaderUrl: "http://l" }] }).active, false);
  assert.equal(resolveRole({ mode: "member", joined: [] }).active, false);
  assert.equal(resolveRole({ mode: "leader", joined: [{ leaderUrl: "http://l" }] }).active, true);
});

test("nodes: CSV 解析（跳注释/表头、Message 内含逗号、短行丢弃）", () => {
  const csv = [
    "* vpngate.net",
    "# HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,OpenVPN_ConfigData_Base64",
    `a.vpngate.net,203.0.113.9,2000000,20,100,Japan,JP,1,2,3,4,2weeks,AS1,msg,with,commas,${B64}`,
    "too,few,columns",
  ].join("\n");
  const rows = parseVpnGateCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hostName, "a.vpngate.net");
  assert.equal(rows[0].countryShort, "JP");
  assert.equal(rows[0].score, 2_000_000);
  assert.equal(rows[0].message, "msg,with,commas");
  assert.equal(rows[0].config, B64);
});

test("nodes: 配置解不开 / 缺 remote 一律拒（绝不猜）", () => {
  assert.equal(decodeConfig("bm90LWEtY29uZmln"), "");
  assert.equal(decodeConfig(Buffer.from("client\ndev tun\n", "utf8").toString("base64")), "");
  assert.match(decodeConfig(B64), /remote 203\.0\.113\.9 1194/);
  assert.deepEqual(parseRemote(CONF), { host: "203.0.113.9", port: 1194 });
  assert.equal(parseRemote("client\ndev tun\n"), null);
  assert.deepEqual(parseRemote("remote 1.2.3.4"), { host: "1.2.3.4", port: 1194 }); // 缺端口 ⇒ 按 OpenVPN 默认 1194
  assert.deepEqual(parseRemote("remote 1.2.3.4\n"), { host: "1.2.3.4", port: 1194 });
});

test("nodes: 候选筛选（Score/国家/skip）与 Score 降序", () => {
  const rows = [rowOf({ hostName: "a", score: 1_000_000 }), rowOf({ hostName: "b", score: 3_000_000 }), rowOf({ hostName: "c", score: 3_000_000, countryShort: "KR", countryLong: "Korea" })];
  assert.deepEqual(candidateNodes({ rows, minScore: 1, scan: 8 }).map((r) => r.hostName), ["b", "c", "a"]);
  assert.deepEqual(candidateNodes({ rows, countries: ["KR"], minScore: 1, scan: 8 }).map((r) => r.hostName), ["c"]);
  assert.deepEqual(candidateNodes({ rows, minScore: 2_000_000, scan: 8 }).map((r) => r.hostName), ["b", "c"]);
  assert.deepEqual(candidateNodes({ rows, minScore: 1, scan: 8, skip: new Set(["b"]) }).map((r) => r.hostName), ["c", "a"]);
  assert.equal(matchCountry(rows[0], []), true);
  assert.equal(matchCountry(rows[2], ["KOREA"]), true);
  assert.equal(matchCountry(rows[0], ["KR"]), false);
});

test("nodes: 缓存读写 + TTL 过期 + auth 文件权限", () => {
  const dir = mkdtempSync(join(tmpdir(), "mi-"));
  saveNodeCache({ dir, source: "test", rows: [rowOf()], now: () => 1_000 });
  assert.equal(loadNodeCache({ dir, now: () => 1_000 }).rows.length, 1);
  assert.equal(loadNodeCache({ dir, ttlMs: 100, now: () => 2_000 }), null, "TTL 过期必须当没有缓存");
  const auth = writeAuthFile({ dir, user: "vpn", pass: "vpn" });
  assert.equal(readFileSync(auth, "utf8"), "vpn\nvpn\n");
  if (process.platform !== "win32") assert.equal(statSync(auth).mode & 0o777, 0o600);
});

test("nodes: fetchNodes 逐源回退（第一源 500，第二源可用）", async () => {
  const lines = [];
  const bad = async () => ({ ok: false, status: 500, text: async () => "boom" });
  const good = async () => ({ ok: true, status: 200, text: async () => `a.vpngate.net,203.0.113.9,9,1,1,Japan,JP,1,1,1,1,2weeks,AS1,,${B64}` });
  const r = await fetchNodes({ sources: ["https://bad", "https://good"], fetchImpl: async (url) => (url.includes("bad") ? bad() : good()), log: (m) => lines.push(m) });
  assert.equal(r.source, "https://good");
  assert.equal(r.rows.length, 1);
  assert.ok(lines.some((l) => l.includes("节点源失败")));
});

test("nodes: probeExitIp 三态（认得出 / 认不出 / 网络异常）", async () => {
  const ok = await probeExitIp({ agent: fakeAgent("x"), fetchImpl: async () => ({ text: async () => "ip=198.51.100.7\ncolo=LAX\n" }) });
  assert.deepEqual({ ok: ok.ok, ip: ok.ip }, { ok: true, ip: "198.51.100.7" });
  const weird = await probeExitIp({ agent: fakeAgent("x"), fetchImpl: async () => ({ text: async () => "nothing here" }) });
  assert.equal(weird.ok, false);
  assert.match(weird.error, /认不出/);
  const dead = await probeExitIp({ agent: fakeAgent("x"), fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  assert.equal(dead.ok, false);
  assert.match(dead.error, /ECONNRESET/);
});

test("tunnel: openvpn 参数必须挡掉主路由（route-nopull + dev 覆盖）", () => {
  const args = buildOpenvpnArgs({ conf: "/d/n.conf", dev: "mltun1", authFile: "/d/auth.txt" });
  const s = args.join(" ");
  assert.ok(s.includes("--route-nopull"));
  assert.ok(s.includes("--pull-filter ignore redirect-gateway"));
  assert.ok(/--dev mltun1/.test(s));
  assert.ok(/--config \/d\/n\.conf/.test(s));
  assert.ok(/--auth-user-pass \/d\/auth\.txt/.test(s));
});

test("tunnel: tun 地址解析与策略路由命令（装/撤对称）", () => {
  assert.equal(parseTunAddr("3: mltun1: <POINTOPOINT> inet 10.8.0.6 peer 10.8.0.5/32 scope global mltun1"), "10.8.0.6");
  assert.equal(parseTunAddr("no address"), "");
  const up = tunnelUpCommands({ tunIp: "10.8.0.6", table: 211, dev: "mltun1", priority: 20001 });
  assert.deepEqual(up[0], ["ip", "rule", "add", "from", "10.8.0.6/32", "lookup", "211", "priority", "20001"]);
  assert.deepEqual(up[1], ["ip", "route", "replace", "default", "dev", "mltun1", "table", "211"]);
  const down = tunnelDownCommands({ tunIp: "10.8.0.6", table: 211 });
  assert.deepEqual(down[1], ["ip", "rule", "del", "from", "10.8.0.6/32", "lookup", "211"]);
  assert.equal(isSupportedPlatform("linux"), true);
  assert.equal(isSupportedPlatform("win32"), false);
});

test("tunnel: startTunnel 就绪 / 提前退出 / 超时", async () => {
  const ok = startTunnel({ bin: "openvpn", args: [], spawnFn: () => fakeChild({ ready: true, pid: 7 }) });
  assert.equal((await ok.ready).pid, 7);
  const died = startTunnel({ bin: "openvpn", args: [], spawnFn: () => fakeChild({ ready: false, exitCode: 1 }) });
  await assert.rejects(died.ready, /提前退出/);
  const stuck = startTunnel({ bin: "openvpn", args: [], timeoutMs: 30, spawnFn: () => fakeChild({ ready: false }) });
  await assert.rejects(stuck.ready, /没等到/);
});

test("tunnel: waitTunAddr 重试后拿到地址；relaxRpf 改/跳过", async () => {
  let calls = 0;
  const runCmdFn = async () => {
    calls += 1;
    return calls >= 3 ? { code: 0, stdout: "inet 10.8.0.9/32", stderr: "" } : { code: 0, stdout: "", stderr: "" };
  };
  const got = await waitTunAddr({ dev: "mltun0", runCmdFn, wait: async () => {}, tries: 5 });
  assert.equal(got.ip, "10.8.0.9");
  const empty = await waitTunAddr({ dev: "mltun0", runCmdFn: async () => ({ code: 1, stdout: "", stderr: "Device not found" }), wait: async () => {}, tries: 2 });
  assert.equal(empty.ip, "");
  assert.match(empty.out, /Device not found/);

  const written = [];
  const r = await relaxRpf({ readFile: () => "1\n", writeFile: (p, v) => written.push([p, v]), log: () => {} });
  assert.equal(r.ok, true);
  assert.equal(written.length, 2);
  assert.deepEqual(written[1], ["/proc/sys/net/ipv4/conf/default/rp_filter", "2"]);
  const skip = await relaxRpf({ enabled: false, log: () => {} });
  assert.equal(skip.changed.length, 0);
});

test("tunnel: bringUpTunnel 成功；装策略路由失败即停子进程", async () => {
  const cfg = resolveMultiIpConfig({ MSLXDFF_MULTI_IP_COUNT: "1" }, { logDirFn: () => "C:/logs" });
  const node = { conf: "C:/logs/n.conf", host: "203.0.113.9", port: 1194, countryShort: "JP" };
  const cmds = [];
  const okSlot = await bringUpTunnel({
    cfg,
    slotIndex: 0,
    node,
    deps: {
      authFile: "C:/logs/auth.txt",
      log: () => {},
      wait: async () => {},
      spawnFn: () => fakeChild({ ready: true }),
      runCmdFn: async (cmd, args) => {
        cmds.push([cmd, ...args].join(" "));
        if (cmd === "ip" && args[0] === "-4") return { code: 0, stdout: "inet 10.8.0.2/32", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      readFile: () => "2\n",
      writeFile: () => {},
    },
  });
  assert.equal(okSlot.tunIp, "10.8.0.2");
  assert.equal(okSlot.dev, "mltun0");
  assert.ok(cmds.some((c) => c.includes("rule add from 10.8.0.2/32 lookup 210")));

  let killed = false;
  const child = fakeChild({ ready: true });
  await assert.rejects(
    bringUpTunnel({
      cfg,
      slotIndex: 1,
      node,
      deps: {
        authFile: "C:/logs/auth.txt",
        wait: async () => {},
        spawnFn: () => { const c = child; const k = c.kill; c.kill = () => { killed = true; return k(); }; return c; },
        runCmdFn: async (cmd, args) => (args[0] === "-4" ? { code: 0, stdout: "inet 10.8.0.3/32", stderr: "" } : { code: 2, stdout: "", stderr: "RTNETLINK answers: File exists" }),
        readFile: () => "2\n",
        writeFile: () => {},
      },
    }),
    /装策略路由失败/,
  );
  assert.equal(killed, true, "装路由失败必须把这槽的子进程收掉");
});

test("dispatch: 空池走直连兜底", async () => {
  const fallback = fakeAgent("direct");
  const d = createMultiIpDispatcher({ slots: [], agentFactory: (a) => fakeAgent(a), fallbackAgent: fallback });
  assert.equal(d.size, 0);
  d.dispatch({ headers: [] }, {});
  assert.equal(fallback.dispatched.length, 1);
  await d.close();
});

test("dispatch: session 粘性选槽 + setSlots 上池", async () => {
  const made = [];
  const d = createMultiIpDispatcher({ slots: [], agentFactory: (a) => { const ag = fakeAgent(a); made.push(ag); return ag; }, fallbackAgent: fakeAgent("direct") });
  await d.setSlots([{ dev: "mltun0", tunIp: "10.8.0.2", table: 210, node: { hostName: "a" } }, { dev: "mltun1", tunIp: "10.8.0.3", table: 211, node: { hostName: "b" } }]);
  assert.equal(d.size, 2);
  const h1 = ["x-opencode-session", "s-1"];
  d.dispatch({ headers: h1 }, {});
  const first = made.filter((m) => m.dispatched.length === 1)[0];
  d.dispatch({ headers: h1 }, {});
  assert.equal(first.dispatched.length, 2, "同一 session 必须粘同一条隧道");
  d.dispatch({ headers: ["x-opencode-session", "s-2"] }, {});
  assert.equal(made.reduce((n, m) => n + m.dispatched.length, 0), 3);
  await d.close();
});

test("dispatch: 429 FreeUsageLimitError ⇒ 换出口；失败则槽置空不再被选中", async () => {
  const logs = [];
  let handlers = [];
  const made = [];
  const rebuild = async () => ({ dev: "mltun0", tunIp: "10.8.0.99", table: 210, node: { hostName: "next" } });
  const d = createMultiIpDispatcher({
    slots: [],
    agentFactory: (a) => { const ag = { addr: a, dispatched: [], dispatch(o, h) { this.dispatched.push(o); handlers.push(h); return { ok: true }; }, async close() {} }; made.push(ag); return ag; },
    fallbackAgent: fakeAgent("direct"),
    rebuild,
    verifyExit: async () => ({ ok: true, ip: "198.51.100.9", ms: 3 }),
    log: (m) => logs.push(m),
  });
  await d.setSlots([{ dev: "mltun0", tunIp: "10.8.0.2", table: 210, node: { hostName: "a" } }]);
  d.dispatch({ headers: ["x-opencode-session", "s"] }, { onHeaders() {}, onData() {}, onComplete() {}, onError() {} });
  const h = handlers[0];
  h.onHeaders(429, [], () => {}, "Too Many Requests");
  h.onData(Buffer.from('{"error":{"message":"FreeUsageLimitError"}}'));
  h.onComplete([]);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const st = d.stats();
  assert.equal(st.slots[0].swaps, 1);
  assert.equal(st.slots[0].tunIp, "10.8.0.99");
  assert.equal(st.slots[0].exitIp, "198.51.100.9");
  assert.ok(logs.some((l) => l.includes("判为「free-quota」")), "429 FreeUsageLimitError 必须判为按出口 IP 计的额度信号");
  assert.ok(logs.some((l) => l.includes("→ 10.8.0.99")), "换出口的日志必须写明从哪换到哪");

  // 换出口失败 ⇒ 槽置空（不再被选中），本发走直连
  const bad = createMultiIpDispatcher({
    slots: [],
    agentFactory: (a) => ({ addr: a, dispatched: [], dispatch(o, h) { this.dispatched.push(o); return h; }, async close() {} }),
    fallbackAgent: fakeAgent("direct"),
    rebuild: async () => { throw new Error("候选节点用尽"); },
    log: (m) => logs.push(m),
  });
  await bad.setSlots([{ dev: "mltun0", tunIp: "10.8.0.2", table: 210 }]);
  const r = await bad.swap(0, { status: 429 });
  assert.equal(r.skipped, false);
  assert.match(r.error, /候选节点用尽/);
  const st2 = bad.stats();
  assert.equal(st2.slots[0].tunIp, "");
  assert.equal(st2.slots[0].cooling, true);
  assert.ok(logs.some((l) => l.includes("原槽保持原状") || l.includes("换出口失败")));
  await d.close();
  await bad.close();
});

test("index: 五道门各自诚实跳过", async () => {
  const logs = [];
  const log = (m) => logs.push(m);
  const base = { log, deps: { exitHook: false, joined: [{ name: "g", leaderUrl: "" }] } };

  assert.equal(createMultiIpPool({ env: { MSLXDFF_MULTI_IP_POOL: "0" }, ...base }), null);
  assert.ok(logs.some((l) => l.includes("已关闭")));

  logs.length = 0;
  assert.equal(createMultiIpPool({ env: { MSLXDFF_MULTI_IP_MODE: "member" }, ...base }), null);
  assert.ok(logs.some((l) => l.includes("出口池只由组长建")));
  logs.length = 0;
  assert.equal(createMultiIpPool({ env: {}, log, deps: { exitHook: false, joined: [] } }), null, "单机（没带任何组）不建池");
  assert.ok(logs.some((l) => l.includes("MSLXDFF_MULTI_IP_MODE=leader")), "跳过时必须告诉用户怎么强开");

  logs.length = 0;
  assert.equal(createMultiIpPool({ env: {}, log, deps: { exitHook: false, joined: [{ name: "g", leaderUrl: "" }], supported: false, platform: "win32" } }), null);
  assert.ok(logs.some((l) => l.includes("tun 设备与 ip rule")));

  logs.length = 0;
  assert.equal(createMultiIpPool({ env: {}, log, deps: { exitHook: false, joined: [{ name: "g", leaderUrl: "" }], platform: "linux", isRoot: () => false } }), null);
  assert.ok(logs.some((l) => l.includes("需要 root")));

  logs.length = 0;
  const pool = createMultiIpPool({ env: {}, log, deps: { exitHook: false, joined: [{ name: "g", leaderUrl: "" }], platform: "linux", isRoot: () => true, checkOpenvpn: async () => ({ ok: false, why: "not found" }) } });
  assert.ok(pool, "openvpn 门在 bootstrap 里判，池对象照常返回（异步跳过，绝不阻塞启动）");
  await pool.ready;
  assert.equal(pool.stats().tunnels, 0);
  assert.ok(logs.some((l) => l.includes("没找到可用的")));
});

test("index: 全通过 ⇒ 起 N 槽并上池（出口 IP 取证进 stats）", async () => {
  const logs = [];
  const rows = [rowOf({ hostName: "a" }), rowOf({ hostName: "b" }), rowOf({ hostName: "c" })];
  const pool = createMultiIpPool({
    env: { MSLXDFF_MULTI_IP_COUNT: "2", MSLXDFF_MULTI_IP_STANDBY: "0" },
    log: (m) => logs.push(m),
    deps: {
      exitHook: false,
      joined: [{ name: "g", leaderUrl: "" }],
      platform: "linux",
      isRoot: () => true,
      checkOpenvpn: async () => ({ ok: true, version: "OpenVPN 2.6.0" }),
      loadNodeCache: () => ({ rows, source: "test" }),
      materializeNode: ({ row }) => ({ ...row, conf: "C:/logs/n.conf", host: row.ip, port: 1194 }),
      bringUpTunnel: async ({ slotIndex }) => ({ dev: `mltun${slotIndex}`, table: 210 + slotIndex, priority: 20000 + slotIndex, tunIp: `10.8.0.${slotIndex + 2}`, pid: 100 + slotIndex, stop: () => {}, tail: () => "" }),
      tearDownTunnel: async () => {},
      probeExitIp: async ({ agent }) => ({ ok: true, ip: agent.addr === "10.8.0.2" ? "198.51.100.1" : "198.51.100.2", ms: 5 }),
      agentFactory: (a) => fakeAgent(a),
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => "{}" }),
    },
  });
  await pool.ready;
  const st = pool.stats();
  assert.equal(st.tunnels, 2);
  assert.equal(st.slots.length, 2);
  assert.deepEqual(st.slots.map((s) => s.exitIp), ["198.51.100.1", "198.51.100.2"]);
  assert.ok(logs.some((l) => l.includes("出口池就绪")));
  await pool.close();
  assert.equal(pool.stats().tunnels, 0);
});