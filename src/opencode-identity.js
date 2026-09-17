import crypto from "node:crypto";

// opencode 客户端身份规格单一来源（源码 packages/schema/src/identifier.ts +
// packages/opencode/src/session/llm/request.ts）：id = <prefix>_ + 12 位 hex
// (timestamp*4096+同毫秒计数，截 48bit) + 14 位 base62，共 26 字符；UA 必须 "opencode/<semver>"。
// zen 免费层 2026-09-17 起按该规格放行（缺版本 UA 或 id 形状不符 → 403 FreeTierError）。
const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const DEFAULT_OPENCODE_UA = "opencode/1.17.20";
let idLastTs = 0;
let idCounter = 0;

export function opencodeIdTail(timestamp = Date.now()) {
  if (timestamp !== idLastTs) {
    idLastTs = timestamp;
    idCounter = 0;
  }
  idCounter += 1;
  const value = BigInt(timestamp) * 0x1000n + BigInt(idCounter);
  let tail = "";
  for (let i = 0; i < 6; i++) {
    tail += Number((value >> BigInt(40 - 8 * i)) & 0xffn)
      .toString(16)
      .padStart(2, "0");
  }
  for (const b of crypto.randomBytes(14)) tail += ID_CHARS[b % 62];
  return tail;
}

// 摘要派生：同种子恒同 id（会话亲和），形态仍合规
export function digestIdTail(digest) {
  let tail = digest.subarray(0, 6).toString("hex");
  for (const b of digest.subarray(6, 20)) tail += ID_CHARS[b % 62];
  return tail;
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
