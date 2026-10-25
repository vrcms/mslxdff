// multi-ip-pool / selftest 判语回归（IO 全注入，零网络）：
//   基线 429 + 出口有 200 ⇒ multi-ip-works；出口也全 429 ⇒ also-limited；出口全不可达 ⇒ unreachable。
import test from "node:test";
import assert from "node:assert/strict";
import { runMultiIpCompare, VERDICT_ZH, MITEST_DEFAULT } from "../src/multi-ip-pool/selftest.js";

const CONF = "client\ndev tun\nproto udp\nremote 203.0.113.9 1194\n";
const B64 = Buffer.from(CONF, "utf8").toString("base64");
const rows = [1, 2, 3, 4].map((i) => ({
  hostName: `v${i}.vpngate.net`, ip: `203.0.113.${i}`, score: 3_000_000 - i, ping: 10 + i, speed: 1,
  countryLong: "Japan", countryShort: "JP", sessions: 1, uptime: 1, totalUsers: 1, totalTraffic: 1,
  logType: "2weeks", operator: "AS1", message: "", config: B64,
}));

/** baseline：直连结果。exitByAddr：每个出口地址各自的探索结果（缺省按 fallback）。 */
function deps({ baseline, exitByAddr = {}, fallback = { ok: true, status: 200, kind: "none" } } = {}) {
  return {
    joined: [{ name: "g", leaderUrl: "" }],
    platform: "linux",
    supported: true,
    isRoot: () => true,
    checkOpenvpn: async () => ({ ok: true, version: "OpenVPN 2.6.0" }),
    loadNodeCache: () => ({ rows, source: "test" }),
    materializeNode: ({ row }) => ({ ...row, conf: "C:/logs/n.conf", host: row.ip, port: 1194 }),
    bringUpTunnel: async ({ slotIndex }) => ({ dev: `mltun${slotIndex}`, table: 210 + slotIndex, priority: 20000 + slotIndex, tunIp: `10.8.0.${slotIndex + 2}`, pid: 100 + slotIndex, stop: () => {}, tail: () => "" }),
    tearDownTunnel: async () => {},
    probeExitIp: async ({ agent }) => ({ ok: true, ip: `198.51.100.${agent.addr.split(".").pop()}`, ms: 4 }),
    agentFactory: (addr) => ({ addr, async close() {} }),
    session: "ses_fixed",
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "{}" }),
    probeUpstream: async ({ addr }) => (addr === "" ? baseline : { addr, ms: 7, ...(exitByAddr[addr] || fallback) }),
    log: () => {},
  };
}

const quotaless = { ok: false, status: 429, kind: "free-quota" };

test("判语：基线 429 + 出口有 200 ⇒ multi-ip-works", async () => {
  const r = await runMultiIpCompare({ count: 3, env: {}, deps: deps({ baseline: quotaless, fallback: { ok: true, status: 200, kind: "none" } }) });
  assert.equal(r.status, "ok");
  assert.equal(r.baseLimited, true);
  assert.equal(r.okCount, 3);
  assert.equal(r.verdict, "multi-ip-works");
  assert.ok(VERDICT_ZH["multi-ip-works"].next.includes("有用"));
});

test("判语：出口也全 429 ⇒ multi-ip-also-limited（换 IP 抬不动）", async () => {
  const r = await runMultiIpCompare({ count: 3, env: {}, deps: deps({ baseline: quotaless, fallback: quotaless }) });
  assert.equal(r.verdict, "multi-ip-also-limited");
  assert.equal(r.limitedCount, 3);
  assert.ok(VERDICT_ZH["multi-ip-also-limited"].next.includes("MSLXDFF_MULTI_IP_POOL=0"));
});

test("判语：出口全网络不可达 ⇒ multi-ip-unreachable", async () => {
  const r = await runMultiIpCompare({ count: 2, env: {}, deps: deps({ baseline: quotaless, fallback: { ok: false, status: 0, kind: "network", error: "ECONNRESET" } }) });
  assert.equal(r.verdict, "multi-ip-unreachable");
  assert.equal(r.netCount, 2);
});

test("判语：有的成有的不成 ⇒ mixed", async () => {
  const d = deps({ baseline: quotaless, fallback: quotaless, exitByAddr: { "10.8.0.2": { ok: true, status: 200, kind: "none" } } });
  const r = await runMultiIpCompare({ count: 3, env: {}, deps: d });
  assert.equal(r.verdict, "mixed", "第 0 条隧道（10.8.0.2）成功、其余受限 ⇒ 部分可用");
  assert.equal(r.okCount, 1);
});

test("门：关闭 / 组员 / 非 Linux / 无 root / openvpn 缺失 一律如实跳过", async () => {
  assert.equal((await runMultiIpCompare({ env: { MSLXDFF_MULTI_IP_POOL: "0" }, deps: deps({ baseline: quotaless }) })).status, "skip");
  const member = deps({ baseline: quotaless });
  member.joined = [{ name: "g", leaderUrl: "http://leader" }];
  assert.match((await runMultiIpCompare({ env: {}, deps: member })).reason, /角色是 member/);
  const win = deps({ baseline: quotaless });
  win.supported = false;
  win.platform = "win32";
  assert.match((await runMultiIpCompare({ env: {}, deps: win })).reason, /需要 Linux/);
  const noroot = deps({ baseline: quotaless });
  noroot.isRoot = () => false;
  assert.match((await runMultiIpCompare({ env: {}, deps: noroot })).reason, /需要 root/);
  const noovpn = deps({ baseline: quotaless });
  noovpn.checkOpenvpn = async () => ({ ok: false, why: "command not found" });
  assert.match((await runMultiIpCompare({ env: {}, deps: noovpn })).reason, /不可用/);
});

test("采样上限与默认值：count 被夹在 1..MITEST_MAX，缺省 3", async () => {
  assert.equal(MITEST_DEFAULT, 3);
  const r = await runMultiIpCompare({ count: 999, env: {}, deps: deps({ baseline: quotaless }) });
  assert.equal(r.requested, 4, "本地只有 4 个候选，取满候选为止（上限 8 不越界）");
  const one = await runMultiIpCompare({ count: 1, env: {}, deps: deps({ baseline: quotaless }) });
  assert.equal(one.requested, 1);
  assert.ok(one.exits[0].hostName);
});