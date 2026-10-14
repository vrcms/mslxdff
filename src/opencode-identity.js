import crypto from "node:crypto";

// opencode 客户端身份规格单一来源。真值 = 上游 packages/schema/src/identifier.ts：
// id = <prefix>_ + 12 位 hex 时间段 + 14 位 base62；UA 必须 "opencode/<semver>"。
// ⚠ 时间段是**倒序**的：value = ~(timestamp*4096 + counter) & 48bit（descending，最新排最前）。
//   正序时钟不合规——zen 免费层自 2026-10-13 起把低 12 位**反解回 counter** 校验，只接受 [0,63]；
//   正序 id 反解出 4094 → 403 FreeTierError（现网实测：counter=1/40 → 200，counter=4094 → 403）。
//   时钟半段不校验：ms*4096 如今已需 53bit，截到 48bit 必回绕——真客户端自己反解出来是 1972 年。
//   ⇒ 会话 id 可以继续由摘要确定性派生（跨重启稳定），只需把低 12 位强制成合法 counter。
// 旧判据全部仍有效：形状正则（2026-09-17）、UA ≥ 1.18.0（2026-09-18，低版本 426 UpgradeRequired）、
//   以及请求体那半道 agent 形状闸（stream + 核心五工具，见 free-lane.js）。
const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MASK48 = 0xffffffffffffn;
const MASK12 = 0xfffn;
// 同毫秒内第 N 个 id：免费层只认反解后 ∈[0,63]，越界必 403 ⇒ 到 63 回头，不无限自增
const COUNTER_MAX = 63;
const DEFAULT_OPENCODE_UA = "opencode/1.18.31";
let idLastTs = 0;
let idCounter = 0;

/** 合规时间段：倒序的 timestamp*4096+counter 截 48bit，恒 12 位小写 hex */
export function identifierTimeHex(timestamp = Date.now(), counter = 1) {
  return ((~(BigInt(timestamp) * 0x1000n + BigInt(counter))) & MASK48).toString(16).padStart(12, "0");
}

/**
 * 从 12 位 hex 时间段反解 per-ms 计数——与免费层闸门同一判据。
 * 值域 0..4095，闸门只放行 ≤63；形状不符返回 NaN（绝不抛，调用方用 Number.isInteger 自检）。
 */
export function counterFromTimeHex(hex) {
  if (typeof hex !== "string" || !/^[0-9a-f]{12}$/i.test(hex)) return Number.NaN;
  return Number((~BigInt("0x" + hex)) & MASK12);
}

function base62From(bytes) {
  let out = "";
  for (const b of bytes) out += ID_CHARS[b % 62];
  return out;
}

export function opencodeIdTail(timestamp = Date.now()) {
  if (timestamp !== idLastTs) {
    idLastTs = timestamp;
    idCounter = 0;
  }
  idCounter = (idCounter % COUNTER_MAX) + 1;
  return identifierTimeHex(timestamp, idCounter) + base62From(crypto.randomBytes(14));
}

// 摘要派生：同种子恒同 id（会话亲和——上游按 session 归组免费额度与 prompt cache，改成现取
// 时钟会让同一会话每请求换号，绝不）。时钟半段照摘要填（不校验），低 12 位强制 counter=1。
export function digestIdTail(digest) {
  const time = ((BigInt("0x" + digest.subarray(0, 6).toString("hex")) & ~MASK12) | ((~1n) & MASK12)) & MASK48;
  return time.toString(16).padStart(12, "0") + base62From(digest.subarray(6, 20));
}

export function genId(prefix) {
  return `${prefix}${opencodeIdTail()}`;
}

export function opencodeUa() {
  return process.env.MSLXDFF_OPENCODE_UA || DEFAULT_OPENCODE_UA;
}

// 旁路（-chat curl 工具 / bench 直连）共用同一身份，避免各自伪造头再被 403
export function opencodeClientIdentity() {
  return {
    "User-Agent": opencodeUa(),
    "x-opencode-session": genId("ses_"),
    "x-opencode-request": genId("msg_"),
  };
}
