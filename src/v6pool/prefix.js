// v6pool · IPv6 前缀算术（纯函数，零 IO）：解析 / 规范化 / 取网络号 / 随机主机号。
//
// 为什么自己写：Node 没有内建 IPv6 前缀算术（`net.isIPv6` 只判形状），
// 而本功能的核心动作就是「在给定前缀里造一个合法、不与现有地址撞车的主机号」。
// 卫生规则（跳过 0/1/全 1、扰动 EUI-64 的 ff:fe 标记）照抄 v6pool 的 sanitizeHost——
// 那几条是为了让出口地址看起来不像 SLAAC 自生成的地址（v6pool 的「unlinkable exits」）。
const M16 = 0xffffn;

/** 解析 IPv6 字面量 → BigInt(128bit)。非法返回 null。支持 `::` 压缩、`[..]` 包裹、`%zone`、v4 尾巴。 */
export function parseV6(raw) {
  let s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (s.includes(".")) {
    const at = s.lastIndexOf(":");
    if (at < 0) return null;
    const v4 = s.slice(at + 1).split(".");
    if (v4.length !== 4 || !v4.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255)) return null;
    const n = v4.reduce((a, x) => ((a << 8) | Number(x)) >>> 0, 0) >>> 0;
    s = `${s.slice(0, at)}:${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (head.length + tail.length > 8) return null;
  const fill = 8 - head.length - tail.length;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  let out = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out = (out << 16n) | BigInt(`0x${g}`);
  }
  return out;
}

/** BigInt → 规范化 IPv6 文本（小写；最长零段压缩成 `::`，RFC 5952 只压 ≥2 段）。 */
export function formatV6(big) {
  const groups = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((big >> BigInt(i * 16)) & M16));
  let bestAt = -1;
  let bestLen = 0;
  let curAt = -1;
  let curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === 0) {
      if (curAt < 0) curAt = i;
      curLen += 1;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestAt = curAt;
      }
    } else {
      curAt = -1;
      curLen = 0;
    }
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(":");
  return `${hex.slice(0, bestAt).join(":")}::${hex.slice(bestAt + bestLen).join(":")}`;
}

/** `"2001:db8::/64"` → `{ addr: BigInt, bits: 64, text: "2001:db8::" }`；非法返回 null。 */
export function parsePrefix(raw) {
  const s = String(raw ?? "").trim();
  const slash = s.lastIndexOf("/");
  if (slash < 0) return null;
  const bits = Number(s.slice(slash + 1));
  if (!Number.isInteger(bits) || bits < 0 || bits > 128) return null;
  const addr = parseV6(s.slice(0, slash));
  if (addr === null) return null;
  return { addr, bits, text: formatV6(networkOf(addr, bits)) };
}

/** /bits 前缀里有几位主机位（= 可用地址的指数）。 */
export function hostBitsOf(bits) {
  return 128 - Number(bits);
}

/** 该地址在 /bits 下的网络号（主机位清零）。 */
export function networkOf(addr, bits) {
  if (bits <= 0) return 0n;
  if (bits >= 128) return addr;
  return addr & ~((1n << BigInt(128 - bits)) - 1n);
}

/** 随机主机号（m 位）。用 rnd() 拼 32bit 块，避免一次 Math.random 只有 53 位精度。 */
export function randomHost(m, rnd = Math.random) {
  let v = 0n;
  let got = 0;
  while (got < m) {
    const take = Math.min(32, m - got);
    const r = Math.floor(rnd() * 0x100000000) >>> 0;
    v = (v << BigInt(take)) | (BigInt(r) & ((1n << BigInt(take)) - 1n));
    got += take;
  }
  return v;
}

/** 该 64 位 IID 是否带 EUI-64 的 ff:fe 标记（RFC 4291 附录 A：MAC 派生的 SLAAC 地址）。 */
export function isEui64(iid) {
  return ((iid >> 24n) & M16) === 0xfffen;
}

/**
 * 主机号卫生：m>2 时跳过 0/1/全 1；m>=40 时扰动 ff:fe 标记。循环有界（8 次）且确定。
 */
export function sanitizeHost(v, m) {
  const mask = m >= 128 ? (1n << 128n) - 1n : (1n << BigInt(m)) - 1n;
  let x = v & mask;
  for (let i = 0; i < 8; i++) {
    if (m >= 40 && isEui64(x)) {
      x = (x ^ 0x0000000200000000n) & mask;
      continue;
    }
    if (m > 2 && (x === 0n || x === 1n || x === mask)) {
      x = (x + 1n) & mask;
      continue;
    }
    return x;
  }
  return x;
}

/** 在前缀里造一个随机地址（主机号随机 + 卫生规则）。m<=0（/128）时只能返回前缀自身。 */
export function randomAddress(prefix, rnd = Math.random) {
  const m = hostBitsOf(prefix.bits);
  if (m <= 0) return formatV6(prefix.addr);
  const host = sanitizeHost(randomHost(m, rnd), m);
  return formatV6(networkOf(prefix.addr, prefix.bits) | host);
}

/** 地址是否落在该前缀里。 */
export function inPrefix(addr, prefix) {
  return networkOf(addr, prefix.bits) === networkOf(prefix.addr, prefix.bits);
}
