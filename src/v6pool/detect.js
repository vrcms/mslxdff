// v6pool · 自动判断本机有没有可用的 IPv6 池（纯解析 + 可注入 IO，便于单测）。
//
// 四关，任一不过就诚实跳过（并给出「下一步该跑什么」）：
//   ① 平台：只有 Linux 能读 /proc 并用 ip 命令（与 wireproxy 预编译平台限制同口径）；
//   ② 地址：/proc/net/if_inet6 里必须有 scope=global 的地址；
//   ③ 前缀：该地址的前缀主机位 ≥ minHostBits（/128 只有 1 个地址，不构成池）；
//   ④ 认领：ip_nonlocal_bind=1（直接 bind，零改动）或 root（能 ip addr add）。
//
// ⚠ 本模块**不假装知道**「整段有没有真路由到本机」——那只能靠 probe.js 从池里的地址实测。
// 内核接受地址（bind 成功）≠ 机房把回包送回来；两者混为一谈正是「池看起来就绪、请求全黑洞」的根因。
import { readFileSync } from "node:fs";
import { formatV6, hostBitsOf, networkOf, parsePrefix, parseV6 } from "./prefix.js";

/** /proc/net/if_inet6 的 scope 列：00=global、10=host、20=link、40=site（都是 hex）。 */
export const SCOPE_GLOBAL = 0;

/** 解析 /proc/net/if_inet6：`<32 位 hex 地址> <ifindex> <prefixlen> <scope> <flags> <网卡>`。 */
export function parseIfInet6(raw) {
  const out = [];
  for (const line of String(raw ?? "").split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6 || !/^[0-9a-f]{32}$/i.test(f[0])) continue;
    const addr = parseV6(f[0].toLowerCase().match(/.{4}/g).join(":"));
    if (addr === null) continue;
    out.push({
      addr,
      text: formatV6(addr),
      ifindex: parseInt(f[1], 16),
      bits: parseInt(f[2], 16),
      scope: parseInt(f[3], 16),
      iface: f[5],
    });
  }
  return out;
}

function skip(reason, hint) {
  return { ok: false, reason, hint };
}

/**
 * 四关判定：把「本机事实」变成「可用池 或 具体跳过原因」。
 * 全部依赖注入（测试不用真读 /proc、不用真 root）。
 */
export function pickPool({
  entries = [],
  nonlocalBind = 0,
  uid = -1,
  platform = process.platform,
  explicitPrefix = "",
  explicitIface = "",
  minHostBits = 8,
  claim = "auto",
} = {}) {
  if (platform !== "linux") {
    return skip(`本平台（${platform}）不支持：需要 Linux 的 /proc 与 ip 命令`, "非 Linux 机器不需要本功能（WARP 池同样只在 Linux 可用）");
  }
  const globals = entries.filter((e) => e.scope === SCOPE_GLOBAL);
  let addr;
  let bits;
  let iface;
  let source;
  if (explicitPrefix) {
    const p = parsePrefix(explicitPrefix);
    if (!p) return skip(`MSLXDFF_V6_PREFIX 解析失败：${explicitPrefix}`, "格式形如 2001:db8:1:2::/64");
    addr = p.addr;
    bits = p.bits;
    source = "env";
    iface = explicitIface || globals[0]?.iface || "";
  } else {
    if (!globals.length) {
      return skip("本机没有任何全局 IPv6 地址（只有 link-local / loopback）", "确认网卡上启用了 IPv6，且运营商或机房确实给了 IPv6");
    }
    const picked = (explicitIface && globals.find((e) => e.iface === explicitIface)) || globals[0];
    addr = picked.addr;
    bits = picked.bits;
    iface = explicitIface || picked.iface;
    source = "proc";
  }
  const hostBits = hostBitsOf(bits);
  if (hostBits < minHostBits) {
    return skip(
      `前缀 /${bits} 只有 ${hostBits} 位主机位（< ${minHostBits}），不构成池`,
      `该地址是 /${bits}：整段没路由到本机时换不了 IP。若确认整段可用，用 MSLXDFF_V6_PREFIX=<段>/<位数> 显式指定`,
    );
  }
  const mode = claim === "auto" ? (nonlocalBind === 1 ? "bind" : uid === 0 ? "add" : "none") : claim;
  if (mode === "bind" && nonlocalBind !== 1) {
    return skip("MSLXDFF_V6_CLAIM=bind 但 net.ipv6.ip_nonlocal_bind≠1", "sysctl -w net.ipv6.ip_nonlocal_bind=1，或改用 MSLXDFF_V6_CLAIM=add");
  }
  if (mode === "add" && uid !== 0) {
    return skip(`MSLXDFF_V6_CLAIM=add 需要 root（当前 uid=${uid}）`, "以 root 跑 daemon，或 sysctl -w net.ipv6.ip_nonlocal_bind=1 后设 MSLXDFF_V6_CLAIM=bind");
  }
  if (mode === "none") {
    return skip("既没有 ip_nonlocal_bind=1，也不是 root ⇒ 内核会拒绝 bind 池里的地址（EADDRNOTAVAIL）", "二选一：sysctl -w net.ipv6.ip_nonlocal_bind=1，或以 root 跑（可 ip addr add）");
  }
  return {
    ok: true,
    addr,
    bits,
    iface,
    hostBits,
    mode,
    source,
    prefix: `${formatV6(networkOf(addr, bits))}/${bits}`,
    /** 本机自己的全局地址：造池时避开它们（别把机器正在用的地址当池里的"新"地址） */
    mine: globals.map((e) => e.text),
  };
}

/** 真机路径：读 /proc 与 /proc/sys（可整体注入，测试零 IO）。 */
export function detectPool({ cfg = {}, entries, nonlocalBind, uid, platform = process.platform, readFile = (p) => readFileSync(p, "utf8") } = {}) {
  const read = (p, dflt) => {
    try {
      return readFile(p);
    } catch {
      return dflt;
    }
  };
  return pickPool({
    entries: entries ?? parseIfInet6(read("/proc/net/if_inet6", "")),
    nonlocalBind: nonlocalBind ?? (Number(String(read("/proc/sys/net/ipv6/ip_nonlocal_bind", "0")).trim()) || 0),
    uid: uid ?? (typeof process.getuid === "function" ? process.getuid() : -1),
    platform,
    explicitPrefix: cfg.prefix || "",
    explicitIface: cfg.iface || "",
    minHostBits: cfg.minHostBits || 8,
    claim: cfg.claim || "auto",
  });
}
