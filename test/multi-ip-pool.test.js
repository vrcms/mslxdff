// multi-ip-pool 回归（零真机依赖：IO 全部注入；非 Linux 只验"诚实跳过"）。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMultiIpConfig, resolveRole, devNameFor, tableFor } from "../src/multi-ip-pool/config.js";
import { parseVpnGateCsv, decodeConfig, parseRemote, candidateNodes, sampleCandidates, clusterOf, countCandidates, probeTargetOf, matchCountry, loadNodeCache, saveNodeCache, writeAuthFile } from "../src/multi-ip-pool/nodes.js";
import { fetchNodes, probeExitIp, describeFetchError, sourceToLocalPath, fetchNodesToFile, metaUrlFor, humanAge, fetchTableMeta } from "../src/multi-ip-pool/nodes-fetch.js";
import { buildOpenvpnArgs, parseTunAddr, tunnelUpCommands, tunnelDownCommands, rulePriorityFor, isSupportedPlatform, startTunnel, waitTunAddr, relaxRpf, bringUpTunnel } from "../src/multi-ip-pool/tunnel.js";
import { openvpnErrorLine, openvpnErrorBrief, probeTcp, probeBatch, probeSummaryLines, createTranscript, envSnapshotLines, slotPlanLines, residualHints } from "../src/multi-ip-pool/diagnose.js";
import { createMultiIpDispatcher } from "../src/multi-ip-pool/dispatch.js";
import { createMultiIpPool } from "../src/multi-ip-pool/index.js";
import { createDialer } from "../src/multi-ip-pool/dial.js";

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

test("nodes: fetch 失败必须挖出真凶（undici 只回 fetch failed，cause.code 才说人话）", async () => {
  assert.ok(describeFetchError({ message: "fetch failed", cause: { code: "ENOTFOUND" } }).includes("DNS"));
  assert.ok(describeFetchError({ cause: { code: "ECONNRESET" } }).includes("重置"));
  assert.ok(describeFetchError({ cause: { code: "ETIMEDOUT" } }).includes("超时"));
  assert.ok(describeFetchError({ cause: { message: "self-signed certificate" } }).includes("TLS"));
  assert.ok(describeFetchError({ cause: { code: "EHOSTUNREACH" } }).includes("EHOSTUNREACH"));
  const boom = async () => { const e = new Error("fetch failed"); e.cause = { code: "ENOTFOUND" }; throw e; };
  await assert.rejects(
    () => fetchNodes({ sources: ["https://a.test/", "https://b.test/"], fetchImpl: boom }),
    (err) => err.message.includes("2 个节点源") && /a\.test/.test(err.message) && /b\.test/.test(err.message) && /DNS/.test(err.message),
    "全失败时异常必须逐源带原因（受限网络下这是用户唯一的线索）",
  );
});

test("nodes: 表龄守卫（meta 说了生成时间 ⇒ 过期要 ⚠，但不拦取表；无 meta 不猜）", async () => {
  assert.equal(metaUrlFor("https://openmili.github.io/aimili-vpngate/vpngate.csv"), "https://openmili.github.io/aimili-vpngate/vpngate.meta.json");
  assert.equal(metaUrlFor("https://raw.githubusercontent.com/OpenMili/aimili-vpngate/main/mirror/vpngate.csv"), "https://raw.githubusercontent.com/OpenMili/aimili-vpngate/main/mirror/vpngate.meta.json");
  assert.equal(metaUrlFor("https://www.vpngate.net/api/iphone/"), "", "官方源没有同源 meta");
  assert.equal(metaUrlFor("/tmp/vpngate.csv"), "", "本地表文件没有 meta");
  assert.equal(humanAge(90_000), "2 分钟");
  assert.equal(humanAge(3 * 3600_000), "3.0 小时");
  assert.equal(humanAge(5 * 86_400_000), "5 天");
  assert.equal(humanAge("nope"), "未知");

  const csv = `a.vpngate.net,203.0.113.9,9,1,1,Japan,JP,1,1,1,1,2weeks,AS1,,${B64}`;
  const table = "https://openmili.github.io/aimili-vpngate/vpngate.csv";
  const good = { ok: true, status: 200, text: async () => csv };
  const metaRes = (iso) => ({ ok: true, status: 200, text: async () => JSON.stringify({ generated_at_iso: iso, row_count: 1 }) });
  const now = Date.parse("2026-10-26T00:00:00Z");
  const lines = [];
  const old = await fetchNodes({
    sources: [table],
    fetchImpl: async (url) => (url.endsWith("vpngate.meta.json") ? metaRes("2026-08-26T11:36:33Z") : good),
    maxAgeMs: 24 * 3600_000,
    now: () => now,
    log: (m) => lines.push(m),
  });
  assert.equal(old.stale, true, "两个月前的表必须判过期（真机踩过：拿旧表 = 一堆早已下线的 IP 白拨几分钟）");
  assert.ok(lines.some((l) => l.includes("⚠ 表已过期")), "过期要显眼地打在取表那行上");
  assert.ok(lines.some((l) => l.includes("MSLXDFF_MULTI_IP_SOURCES") && l.includes("MSLXDFF_MULTI_IP_NODES_FILE")), "要给出换源/自带表两条出路，而不是静默");
  assert.equal(old.rows.length, 1, "过期只是告警，绝不拦取表（也许没有更好的源）");

  const fresh = await fetchNodes({ sources: [table], fetchImpl: async (url) => (url.endsWith("vpngate.meta.json") ? metaRes("2026-10-25T23:00:00Z") : good), maxAgeMs: 24 * 3600_000, now: () => now });
  assert.equal(fresh.stale, false, "一小时前生成的表不能误报");
  assert.equal(fresh.meta.ageMs, 3600_000, "表龄按 meta 的生成时间算，不按取表时刻");

  const noMeta = await fetchNodes({ sources: ["https://www.vpngate.net/api/iphone/"], fetchImpl: async () => good, maxAgeMs: 1 });
  assert.equal(noMeta.meta, null);
  assert.equal(noMeta.stale, false, "不知道表龄就不报警（官方源本来就是活的）");
});

test("nodes: fetchTableMeta 拿不到就 null（404/非 JSON/抛异常都不猜），generated_at 秒级也要认", async () => {
  const src = "https://openmili.github.io/aimili-vpngate/vpngate.csv";
  const withRes = (res) => fetchTableMeta({ source: src, fetchImpl: async () => res });
  assert.equal(await withRes({ ok: false, status: 404, text: async () => "" }), null);
  assert.equal(await withRes({ ok: true, status: 200, text: async () => "not json" }), null);
  assert.equal(await withRes({ ok: true, status: 200, text: async () => JSON.stringify({ generated_at_iso: "nonsense" }) }), null, "时间解不出来 = 当没有 meta");
  assert.equal(await fetchTableMeta({ source: src, fetchImpl: async () => { throw new Error("ECONNRESET"); } }), null, "meta 取不到绝不能拖垮取表");
  assert.equal(await fetchTableMeta({ source: "https://www.vpngate.net/api/iphone/", fetchImpl: async () => { throw new Error("不该打网"); } }), null, "没有同源 meta 的源一次网都不打");
  const at = 1_792_878_552_800;
  const m = await fetchTableMeta({ source: src, fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ generated_at: at / 1000 }) }), now: () => at + 60_000 });
  assert.equal(m.ageMs, 60_000, "generated_at（秒）也要认");
  assert.equal(m.generatedAtIso, new Date(at).toISOString());
});

test("config: 表龄阈值缺省 24 小时（envInt 只认正整数）；显式 SOURCES 与本地表共存", () => {
  assert.equal(resolveMultiIpConfig({}).maxTableAgeMs, 24 * 3600_000);
  assert.equal(resolveMultiIpConfig({ MSLXDFF_MULTI_IP_MAX_TABLE_AGE_MS: "3600000" }).maxTableAgeMs, 3600_000);
  assert.equal(resolveMultiIpConfig({ MSLXDFF_MULTI_IP_MAX_TABLE_AGE_MS: "0" }).maxTableAgeMs, 24 * 3600_000, "非正整数回落缺省（与其它 envInt 项同口径）");
  assert.deepEqual(resolveMultiIpConfig({ MSLXDFF_MULTI_IP_SOURCES: "https://mine.test/a", MSLXDFF_MULTI_IP_NODES_FILE: "/tmp/v.csv" }).sources, ["/tmp/v.csv", "https://mine.test/a"]);
  assert.deepEqual(resolveMultiIpConfig({ MSLXDFF_MULTI_IP_SOURCES: "https://mine.test/a" }).sources, ["https://mine.test/a"], "显式 SOURCES 完全接管（没有活表镜像时也照跑）");
});

test("nodes: 本地表文件可以当源（受限网络抓一份带过去，命中即零网络请求）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mi-file-"));
  const csv = `*vpn_servers\n#HostName,IP,Score\nvpn9.vpngate.net,203.0.113.9,9,1,1,Japan,JP,1,1,1,1,2weeks,AS1,,${B64}\n`;
  writeFileSync(join(dir, "vpngate.csv"), csv);
  let netCalls = 0;
  const r = await fetchNodes({
    sources: [join(dir, "vpngate.csv"), "https://never.test/x.csv"],
    dir,
    fetchImpl: async () => { netCalls++; throw new Error("不该打网"); },
  });
  assert.equal(r.rows.length, 1);
  assert.ok(r.text.includes("vpn9.vpngate.net"), "必须回带 CSV 原文（fetch 子命令要落盘）");
  assert.equal(netCalls, 0, "本地源命中就不该再打网络");
  assert.ok(/x\.csv$/.test(sourceToLocalPath("file:///tmp/x.csv")), "file:// 必须换成本机路径写法");
  assert.equal(sourceToLocalPath("https://a/b"), null, "http(s) 源不能被当成本地路径");
});

test("config: 节点源官方在前、活表镜像(Pages)次之、仓库快照只站末位；NODES_FILE 排最前", () => {
  const d = resolveMultiIpConfig({});
  assert.equal(d.sources.length, 4);
  assert.ok(d.sources[0].includes("vpngate.net"), "官方源必须永远优先");
  assert.ok(d.sources[2].includes("openmili.github.io"), "上游 Actions 只发 Pages；仓库内那份是 2026-08-26 的手工死快照");
  assert.ok(d.sources[3].includes("raw.githubusercontent.com"), "仓库内快照只能作兜墙末位");
  assert.equal(d.nodesFile, "");
  const withFile = resolveMultiIpConfig({ MSLXDFF_MULTI_IP_NODES_FILE: "/tmp/vpngate.csv" });
  assert.equal(withFile.sources[0], "/tmp/vpngate.csv", "本地表排在最前：文件在就一次网络都不打");
  assert.equal(withFile.sources.length, 5, "网络源仍留作后备（本地表路径写错时不至于全盘瘫）");
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
  // 设备名 `mltun1` 不以 tun/tap 开头 ⇒ 必须显式给 --dev-type，否则 openvpn 推不出设备类型
  assert.ok(/--dev-type tun/.test(s), "缺 --dev-type tun：mltun* 这类名字 openvpn 认不出类型");
  assert.throws(() => buildOpenvpnArgs({ conf: "/d/n.conf", dev: "mltun1", authFile: "" }), /缺 authFile/, "空 auth 路径必须当场拒，不许传给 openvpn 变成 usage 错误");
  assert.throws(() => buildOpenvpnArgs({ conf: "", dev: "mltun1", authFile: "/d/auth.txt" }), /缺 conf/);
});

test("tunnel: openvpn 报错要挑「真凶行」，不是恒为 Use --help 的末行", () => {
  const usage = "Options error: Unrecognized option or missing or extra parameter(s): --auth-user-pass (2.6.19)\nUse --help for more information.";
  assert.ok(openvpnErrorLine(usage).startsWith("Options error"), "必须报出 Options error 那行");
  assert.equal(openvpnErrorLine("TLS Error: TLS handshake failed\nsome noise"), "TLS Error: TLS handshake failed");
  assert.equal(openvpnErrorLine("只是普通一行\n第二行"), "第二行", "没有可归因的行时退回末行");
  assert.equal(openvpnErrorLine(""), "");
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

test("nodes: fetchNodesToFile 原样落盘（-multi-ip-pool fetch 的骨架）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mi-tofile-"));
  const out = join(dir, "sub", "vpngate.csv");
  const csv = `*vpn_servers\n#h\nvpn9.vpngate.net,203.0.113.9,9,1,1,Japan,JP,1,1,1,1,2weeks,AS1,,${B64}`;
  const got = await fetchNodesToFile({ sources: ["https://t.test/"], out, fetchImpl: async () => ({ ok: true, status: 200, text: async () => csv }) });
  assert.equal(got.out, out);
  assert.equal(got.rows.length, 1);
  assert.equal(readFileSync(out, "utf8"), csv, "必须原样落 CSV（不能只落解析结果，否则重抓的信息全丢）");
  if (process.platform !== "win32") assert.equal(statSync(out).mode & 0o777, 0o600, "表里带节点凭据，必须 0600");
});

// —— diagnose.js：真机排障全靠这层的输出质量，逐条锁死 ——
test("diagnose: openvpnErrorBrief 一行内给真凶 + 末几行（不再只报 Use --help）", () => {
  const text = "Options error: File is not existing or size 0: undefined (2.6.19)\nSat Oct 25 10:00:00 2026 Note: --auth-user-pass is required\nUse --help for more information.";
  const brief = openvpnErrorBrief(text);
  assert.ok(brief.startsWith("Options error:"), "第一句必须是真凶行");
  assert.ok(brief.includes("‖"), "还要带其余行");
  assert.ok(!brief.includes("Use --help"), "无用的末行进摘要没意义");
});

test("diagnose: probeTcp 判语（通 / 注入失败 / 缺参数），且绝不漏句柄", async () => {
  assert.equal((await probeTcp({ host: "", port: 0 })).ok, false);
  const ok = await probeTcp({ host: "h", port: 443, connectFn: async () => ({ ok: true }) });
  assert.equal(ok.ok, true);
  assert.equal(ok.host, "h");
  const bad = await probeTcp({ host: "h", port: 443, connectFn: async () => { throw Object.assign(new Error("EHOSTUNREACH"), { code: "EHOSTUNREACH" }); } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /EHOSTUNREACH/);
});

test("diagnose: transcript 编号 + 耗时 + 同步落盘（贴一个文件就能定位）", () => {
  const dir = mkdtempSync(join(tmpdir(), "mi-tr-"));
  const mem = [];
  const fs = { mkdirSync: () => {}, appendFileSync: (p, s) => mem.push(s) };
  let nowT = 1_000;
  const t = createTranscript({ dir, out: (l) => mem.push(l), fs, now: () => (nowT += 1_500), fileName: "x.log" });
  t.step("① 环境快照");
  t.say("node v22");
  t.step("② 节点表");
  assert.ok(mem.some((l) => /^\[01 \+1\.5s\] ① 环境快照/.test(l)), `步骤要带编号与耗时，实得：${mem[1]}`);
  assert.ok(mem.some((l) => /^\[01 \+3\.0s\]\s{6,}node v22/.test(l)), "明细行归在同号步骤下且不占编号");
  assert.ok(mem.some((l) => /^\[02 \+/.test(l) && l.includes("② 节点表")));
  assert.ok(t.file.endsWith("x.log"));
  assert.ok(mem.some((l) => l.includes("transcript")), "文件里也要有抬头说明");
});
test("diagnose: 快照与槽计划读得懂、善后命令给得全", () => {
  const cfg = resolveMultiIpConfig({ MSLXDFF_MULTI_IP_COUNTRY: "JP", MSLXDFF_MULTI_IP_COUNT: "2" });
  const lines = envSnapshotLines({ cfg, platform: "linux", root: true, openvpn: { ok: true, version: "OpenVPN 2.6.19" }, files: ["auth.txt(8B)"] });
  assert.ok(lines[0].includes("root 是"));
  assert.ok(lines[1].includes("2.6.19"));
  assert.ok(lines[2].includes("隧道 2 条"));
  assert.ok(lines[4].includes("vpngate.net"));
  const plan = slotPlanLines({ cfg, nodes: [{ hostName: "n1", countryShort: "JP", host: "1.2.3.4", port: 443, proto: "tcp" }] });
  assert.ok(plan[0].includes("1.2.3.4:443") && plan[0].includes("proto tcp") && plan[0].includes("设备 mltun0") && plan[0].includes("表 210"));
  assert.ok(residualHints().length >= 3);
});
// —— 五次修订：可连性取样（真机第三轮教训：一个机房连不上被误读成「整表不通」）——
test("nodes: clusterOf 同机房同网段归一簇；sampleCandidates 按簇轮转（不偏袒一家机房）", () => {
  const rows = [
    rowOf({ hostName: "public-vpn-198", ip: "219.100.37.178", score: 9_000_000 }),
    rowOf({ hostName: "public-vpn-201", ip: "219.100.37.212", score: 8_000_000 }),
    rowOf({ hostName: "public-vpn-229", ip: "219.100.37.217", score: 7_000_000 }),
    rowOf({ hostName: "vpn-jp-1", ip: "203.0.113.9", score: 6_000_000 }),
    rowOf({ hostName: "vpn-jp-2", ip: "203.0.113.10", score: 5_000_000 }),
  ];
  assert.equal(clusterOf(rows[0]), clusterOf(rows[2]), "同前缀 + 同 /24 ⇒ 同一簇（真机三个候选就是这么抱团的）");
  assert.notEqual(clusterOf(rows[0]), clusterOf(rows[3]));
  // 纯 Score 序的前三名全在 public-vpn（一个机房霸榜）；按簇轮转后第 2 条就换了一家
  assert.deepEqual(candidateNodes({ rows, minScore: 1, scan: 3 }).map((r) => r.hostName), ["public-vpn-198", "public-vpn-201", "public-vpn-229"]);
  assert.deepEqual(sampleCandidates({ rows, limit: 3 }).map((r) => r.hostName), ["public-vpn-198", "vpn-jp-1", "public-vpn-201"]);
  assert.equal(sampleCandidates({ rows, limit: 8 }).length, 5, "轮转不丢节点：取满为止");
  assert.deepEqual(sampleCandidates({ rows, limit: 8, perCluster: 1 }).map((r) => r.hostName), ["public-vpn-198", "vpn-jp-1"]);
  assert.equal(countCandidates({ rows, minScore: 7_000_000 }), 3);
  assert.equal(countCandidates({ rows, countries: ["JP"], minScore: 1 }), 5);
});

test("nodes: probeTargetOf 只读解出 host/port/proto；解不开的返 null（不落文件、不猜）", () => {
  const target = probeTargetOf(rowOf());
  assert.deepEqual({ host: target.host, port: target.port, proto: target.proto }, { host: "203.0.113.9", port: 1194, proto: "udp" });
  assert.equal(probeTargetOf({ config: "bm90LWEtY29uZmln" }), null);
});

test("diagnose: probeBatch 限并发、与输入顺序一一对应、注入探针可判生死", async () => {
  let running = 0;
  let peak = 0;
  const nodes = [1, 2, 3, 4, 5].map((i) => ({ hostName: `n${i}`, host: `10.0.0.${i}`, port: 443, proto: "tcp" }));
  const probe = async ({ host }) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setImmediate(r));
    running -= 1;
    return host.endsWith("2") ? { ok: false, ms: 1, error: "连接超时" } : { ok: true, ms: 3 };
  };
  const res = await probeBatch({ nodes, concurrency: 2, probe });
  assert.equal(res.length, 5);
  assert.deepEqual(res.map((r) => r.node.hostName), ["n1", "n2", "n3", "n4", "n5"], "结果必须与输入顺序一一对应（否则判语对不上节点）");
  assert.ok(peak <= 2, `并发必须被夹住，实测峰值 ${peak}`);
  assert.equal(res[1].ok, false);
  assert.match(res[1].error, /超时/);
});

test("diagnose: probeSummaryLines 判死口径分开（UDP 不算不通）+ 簇分布一眼看得出", () => {
  const mk = (hostName, ip, proto, ok) => ({ node: { hostName, ip, proto, score: 9_000_000 }, ok, ms: 1, error: ok ? "" : "连接超时" });
  const lines = probeSummaryLines({
    minScore: 1_000_000,
    results: [mk("public-vpn-1", "219.100.37.1", "tcp", false), mk("public-vpn-2", "219.100.37.2", "tcp", false), mk("vpn-udp", "203.0.113.9", "udp", true)],
  });
  assert.match(lines[0], /取样 3 个（Score 达下限 3 个）→ TCP 通 0｜不通 2/);
  assert.match(lines[0], /另有 1 条 UDP 节点：无握手，不计入判死/);
  assert.match(lines[1], /public-vpn\|219\.100\.37 0\/2 通/, "哪一片不通必须一眼看得出");
  assert.ok(lines.some((l) => l.includes("TCP 探不出结论")));
});

test("dial: 候选择序按簇轮转（真机教训：前三名同一机房 ⇒ 那一片连不上就整池起不来）", async () => {
  const rows = [
    rowOf({ hostName: "public-vpn-198", ip: "219.100.37.178", score: 9_000_000 }),
    rowOf({ hostName: "public-vpn-201", ip: "219.100.37.212", score: 8_000_000 }),
    rowOf({ hostName: "public-vpn-229", ip: "219.100.37.217", score: 7_000_000 }),
    rowOf({ hostName: "vpn-jp-1", ip: "203.0.113.9", score: 6_000_000 }),
    rowOf({ hostName: "vpn-jp-2", ip: "203.0.113.10", score: 5_000_000 }),
  ];
  const tried = [];
  const d = createDialer({
    cfg: resolveMultiIpConfig({ MSLXDFF_MULTI_IP_COUNT: "3" }, { logDirFn: () => "C:/logs" }),
    log: (m) => { const hit = /尝试 ([\w.-]+)（/.exec(m); if (hit) tried.push(hit[1]); },
    deps: {
      loadNodeCache: () => ({ rows, source: "test" }),
      materializeNode: ({ row }) => ({ ...row, conf: "C:/logs/n.conf", host: row.ip, port: 1194, proto: "udp" }),
      bringUpTunnel: async ({ slotIndex, node }) => ({ dev: `mltun${slotIndex}`, table: 210 + slotIndex, priority: 20_000, tunIp: `10.8.0.${slotIndex + 2}`, pid: 1, node, stop: () => {}, tail: () => "" }),
      tearDownTunnel: async () => {},
      probeExitIp: async () => ({ ok: true, ip: "198.51.100.1", ms: 1 }),
      probeHi: async () => ({ ok: true, status: 200, kind: "none", ms: 1 }),
      agentFactory: (addr) => fakeAgent(addr),
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => "{}" }),
    },
  });
  await d.ensureCandidates();
  for (let i = 0; i < 3; i++) await d.openSlot(i);
  assert.deepEqual(tried, ["public-vpn-198", "vpn-jp-1", "public-vpn-201"], "第 2 条必须换一家机房，而不是同机房的第二名");
});

test("CLI 接线：三个命令文件必须 import 得动（拆文件后 import 名写错 = 命令直接崩）", async () => {
  const m = await import("../src/cli/commands/multi-ip-pool.js");
  const t = await import("../src/cli/commands/multi-ip-pool-test.js");
  const n = await import("../src/cli/commands/multi-ip-pool-fetch.js");
  assert.equal(typeof m.handleMultiIpPool, "function");
  assert.deepEqual({ test: typeof t.runTest, fetch: typeof n.runFetch, probe: typeof n.runProbe, survey: typeof n.surveyCandidates }, { test: "function", fetch: "function", probe: "function", survey: "function" });
});