// v6pool 离线测试（一）：prefix / config / detect —— 不触网、不读真 /proc、不改网卡。
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatV6, hostBitsOf, inPrefix, networkOf, parsePrefix, parseV6, randomAddress, sanitizeHost } from "../src/v6pool/prefix.js";
import { DEFAULTS, resolveV6Config } from "../src/v6pool/config.js";
import { SCOPE_GLOBAL, detectPool, parseIfInet6, pickPool } from "../src/v6pool/detect.js";

const dirFn = () => join(tmpdir(), "v6pool-logdir");
function seq(list) {
  let i = 0;
  return () => list[Math.min(i++, list.length - 1)];
}

// ---------- prefix：IPv6 前缀算术 ----------

test("prefix：parseV6/formatV6 往返，且按 RFC 5952 只压 ≥2 段零段", () => {
  assert.equal(formatV6(parseV6("2403:71c0:2000:114a::a")), "2403:71c0:2000:114a::a");
  assert.equal(formatV6(parseV6("2403:71c0:2000:114a:0000:0000:0000:000a")), "2403:71c0:2000:114a::a");
  assert.equal(formatV6(parseV6("::")), "::");
  assert.equal(formatV6(parseV6("::1")), "::1");
  assert.equal(formatV6(parseV6("2001:db8::1")), "2001:db8::1");
  assert.equal(formatV6(parseV6("[2001:db8::1]")), "2001:db8::1");
  assert.equal(formatV6(parseV6("fe80::1%eth0")), "fe80::1");
  assert.equal(formatV6(parseV6("2001:0:1:2:3:4:5:6")), "2001:0:1:2:3:4:5:6", "单段 0 不许压成 ::");
  assert.equal(formatV6(parseV6("::ffff:1.2.3.4")), "::ffff:102:304");
});

test("prefix：parseV6 非法输入一律 null（不抛）", () => {
  for (const bad of ["", "not-an-ip", "1:2:3", "1:2:3:4:5:6:7:8:9", "2001::db8::1", "gggg::1", null, undefined, 42]) {
    assert.equal(parseV6(bad), null, `应判非法：${String(bad)}`);
  }
});

test("prefix：parsePrefix / networkOf / hostBitsOf / inPrefix", () => {
  const p = parsePrefix("2403:71c0:2000:114a::a/64");
  assert.equal(p.bits, 64);
  assert.equal(p.text, "2403:71c0:2000:114a::");
  assert.equal(formatV6(networkOf(p.addr, 64)), "2403:71c0:2000:114a::");
  assert.equal(hostBitsOf(64), 64);
  assert.equal(hostBitsOf(128), 0);
  assert.equal(hostBitsOf(48), 80);
  assert.equal(parsePrefix("2403::/129"), null, "位数越界必须非法");
  assert.equal(parsePrefix("2403::"), null, "缺 /位数 必须非法");
  assert.equal(parsePrefix("nope/64"), null);
  assert.equal(inPrefix(parseV6("2403:71c0:2000:114a:ffff::1"), p), true);
  assert.equal(inPrefix(parseV6("2403:71c0:2000:114b::1"), p), false);
});

test("prefix：randomAddress 恒落前缀内、主机位不取 0/1/全 1、不带 EUI-64 标记", () => {
  const p = parsePrefix("2403:71c0:2000:114a::/64");
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const a = randomAddress(p);
    assert.ok(inPrefix(parseV6(a), p), `必须落前缀内：${a}`);
    seen.add(a);
    const host = parseV6(a) & ((1n << 64n) - 1n);
    assert.notEqual(host, 0n, "全 0 主机号要跳");
    assert.notEqual(host, 1n, "主机号 1 要跳");
    assert.notEqual(host, (1n << 64n) - 1n, "全 1 主机号要跳");
    assert.notEqual((host >> 24n) & 0xffffn, 0xfffen, "ff:fe 标记要扰动");
  }
  assert.ok(seen.size > 190, `随机性太差：200 次只有 ${seen.size} 个不同地址`);
});

test("prefix：sanitizeHost 边界（0/1/全1 递增、ff:fe 扰动、主机位太少时不做卫生）", () => {
  const mask = (1n << 64n) - 1n;
  assert.equal(sanitizeHost(0n, 64), 2n);
  assert.equal(sanitizeHost(1n, 64), 2n);
  assert.equal(sanitizeHost(mask, 64), 2n, "全 1 → 递增到 2");
  const iid = 0x000000fffe000000n;
  assert.equal((iid >> 24n) & 0xffffn, 0xfffen, "测试值本身要带 ff:fe 标记");
  assert.notEqual((sanitizeHost(iid, 64) >> 24n) & 0xffffn, 0xfffen, "扰动后不该再是 ff:fe");
  assert.equal(sanitizeHost(0n, 1), 0n, "主机位只有 1 位时没得选");
});

test("prefix：随机性可复现（同一 rnd 序列 ⇒ 同一地址）", () => {
  const p = parsePrefix("2001:db8::/64");
  const seed = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  assert.equal(randomAddress(p, seq(seed)), randomAddress(p, seq(seed)));
});

// ---------- config ----------

test("config：缺省开 + 自动判断；关词生效；策略/认领白名单；目录落日志根", () => {
  const def = resolveV6Config({}, { logDirFn: dirFn });
  assert.equal(def.enabled, true, "缺省开（有没有池由 detect 按事实判）");
  assert.equal(def.count, DEFAULTS.count);
  assert.equal(def.strategy, "session");
  assert.equal(def.claim, "auto");
  assert.equal(def.rotate, true);
  assert.equal(def.dir, join(dirFn(), "v6pool"));
  assert.equal(resolveV6Config({ MSLXDFF_V6_POOL: "0" }, { logDirFn: dirFn }).enabled, false);
  assert.equal(resolveV6Config({ MSLXDFF_V6_POOL: "off" }, { logDirFn: dirFn }).enabled, false);
  assert.equal(resolveV6Config({ MSLXDFF_V6_POOL: "1" }, { logDirFn: dirFn }).enabled, true);
  assert.equal(resolveV6Config({ MSLXDFF_V6_STRATEGY: "request" }, { logDirFn: dirFn }).strategy, "request");
  assert.equal(resolveV6Config({ MSLXDFF_V6_STRATEGY: "乱写" }, { logDirFn: dirFn }).strategy, "session", "非法策略回落");
  assert.equal(resolveV6Config({ MSLXDFF_V6_CLAIM: "ADD" }, { logDirFn: dirFn }).claim, "add");
  assert.equal(resolveV6Config({ MSLXDFF_V6_CLAIM: "乱写" }, { logDirFn: dirFn }).claim, "auto");
  assert.equal(resolveV6Config({ MSLXDFF_V6_COUNT: "0" }, { logDirFn: dirFn }).count, DEFAULTS.count, "0 非法回落");
  assert.equal(resolveV6Config({ MSLXDFF_V6_PREFIX: "2001:db8::/56" }, { logDirFn: dirFn }).prefix, "2001:db8::/56");
});

// ---------- detect：自动判断有没有池 ----------

const IF_INET6 = [
  "240371c02000114a000000000000000a 02 40 00 80 eth0",
  "fe800000000000000000000000000001 02 40 20 80 eth0",
  "00000000000000000000000000000001 01 80 10 80 lo",
].join("\n");

test("detect：parseIfInet6 取地址/位数/scope/网卡（后四列都是 hex）", () => {
  const e = parseIfInet6(IF_INET6);
  assert.equal(e.length, 3);
  assert.equal(e[0].text, "2403:71c0:2000:114a::a");
  assert.equal(e[0].bits, 64);
  assert.equal(e[0].scope, SCOPE_GLOBAL);
  assert.equal(e[0].iface, "eth0");
  assert.equal(e[0].ifindex, 2);
  assert.equal(e[1].scope, 32, "link-local 的 scope 是 0x20");
  assert.equal(e[2].bits, 128, "loopback 是 /128");
  assert.deepEqual(parseIfInet6("乱写\n"), []);
});

test("detect：四关——非 Linux / 无全局地址 / 前缀太窄 / 认领无权限，各自给具体原因与下一步", () => {
  const win = pickPool({ entries: parseIfInet6(IF_INET6), platform: "win32", uid: 0 });
  assert.equal(win.ok, false);
  assert.match(win.reason, /不支持/);

  const none = pickPool({ entries: parseIfInet6("fe800000000000000000000000000001 02 40 20 80 eth0"), platform: "linux", uid: 0 });
  assert.equal(none.ok, false);
  assert.match(none.reason, /没有任何全局 IPv6 地址/);

  const narrow = pickPool({ entries: parseIfInet6("240371c02000114a000000000000000a 02 80 00 80 eth0"), platform: "linux", uid: 0 });
  assert.equal(narrow.ok, false, "/128 只有 1 个地址，不构成池");
  assert.match(narrow.reason, /主机位/);
  assert.match(narrow.hint, /MSLXDFF_V6_PREFIX/);

  const noperm = pickPool({ entries: parseIfInet6(IF_INET6), platform: "linux", uid: 1000, nonlocalBind: 0 });
  assert.equal(noperm.ok, false);
  assert.match(noperm.reason, /ip_nonlocal_bind/);
  assert.match(noperm.hint, /sysctl/);
});

test("detect：有 /64 时按事实选认领方式（bind 优先于 add），并报出本机自己的地址", () => {
  const bind = pickPool({ entries: parseIfInet6(IF_INET6), platform: "linux", uid: 1000, nonlocalBind: 1 });
  assert.equal(bind.ok, true);
  assert.equal(bind.mode, "bind", "开了 ip_nonlocal_bind 就不该碰网卡");
  assert.equal(bind.iface, "eth0");
  assert.equal(bind.bits, 64);
  assert.equal(bind.hostBits, 64);
  assert.equal(bind.prefix, "2403:71c0:2000:114a::/64");
  assert.deepEqual(bind.mine, ["2403:71c0:2000:114a::a"], "本机自己的地址要报出来，造池时避开");

  const add = pickPool({ entries: parseIfInet6(IF_INET6), platform: "linux", uid: 0, nonlocalBind: 0 });
  assert.equal(add.ok, true);
  assert.equal(add.mode, "add");

  const forced = pickPool({ entries: parseIfInet6(IF_INET6), platform: "linux", uid: 0, nonlocalBind: 0, claim: "bind" });
  assert.equal(forced.ok, false, "显式要 bind 但没开 sysctl ⇒ 诚实拒绝");
});

test("detect：显式前缀优先（给「地址是 /128 但整段真路由」的机器留生路）", () => {
  const d = pickPool({ entries: parseIfInet6(IF_INET6), platform: "linux", uid: 0, explicitPrefix: "2403:71c0:2000:114a::/56" });
  assert.equal(d.ok, true);
  assert.equal(d.bits, 56);
  assert.equal(d.source, "env");
  const bad = pickPool({ entries: [], platform: "linux", uid: 0, explicitPrefix: "乱写" });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /解析失败/);
});

test("detect：detectPool 走真机路径读 /proc（注入 readFile，零 IO）", () => {
  const readFile = (p) => {
    if (p === "/proc/net/if_inet6") return IF_INET6;
    if (p === "/proc/sys/net/ipv6/ip_nonlocal_bind") return "1\n";
    throw new Error(`ENOENT ${p}`);
  };
  const d = detectPool({ cfg: { minHostBits: 8, claim: "auto" }, readFile, uid: 0, platform: "linux" });
  assert.equal(d.ok, true);
  assert.equal(d.mode, "bind");
  const noSys = detectPool({
    cfg: {},
    readFile: (p) => {
      if (p === "/proc/net/if_inet6") return IF_INET6;
      throw new Error("ENOENT");
    },
    uid: 0,
    platform: "linux",
  });
  assert.equal(noSys.mode, "add", "读不到 sysctl 当 0，root 就走 add");
});
