// vendor 自 qwenwork2api-makers 的 edge-functions/_shared/crypto.js（逐字搬，仅加 webcrypto 兜底）。
// 原作者手写 AES/RSA/MD5 是因为 Cloudflare Workers 无 node:crypto；**不要**"顺手优化"成原生实现 ——
// 实测换成 node:crypto 后上游回 `code 101 Signature invalid`（RSA/AES 材料与上游期望不等价）。
// Node 侧需要 globalThis.crypto（getRandomValues / subtle.digest）；<19 用 node:crypto 的 webcrypto 兜底。
if (!globalThis.crypto || !globalThis.crypto.subtle) {
  const { webcrypto } = await import("node:crypto");
  globalThis.crypto = webcrypto;
}

const SBOX = (() => {
  const s = new Uint8Array(256);
  let p = 1;
  let q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    if (q & 0x80) q ^= 0x09;
    q &= 0xff;
    const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
    s[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  s[0] = 0x63;
  return s;
})();

const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

export function utf8(str) {
  return new TextEncoder().encode(str);
}

export function hex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

export function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function unb64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function b64url(bytes) {
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function uuid() {
  const r = new Uint8Array(16);
  crypto.getRandomValues(r);
  r[6] = (r[6] & 0x0f) | 0x40;
  r[8] = (r[8] & 0x3f) | 0x80;
  const h = hex(r);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K = new Int32Array(64);
for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;

function rotl(x, n) {
  return (x << n) | (x >>> (32 - n));
}

export function md5(input) {
  const msg = typeof input === "string" ? utf8(input) : input;
  const len = msg.length;
  const bitLen = len * 8;
  const padLen = (56 - ((len + 1) % 64) + 64) % 64;
  const total = len + 1 + padLen + 8;
  const buf = new Uint8Array(total);
  buf.set(msg, 0);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, bitLen >>> 0, true);
  view.setUint32(total - 4, Math.floor(bitLen / 4294967296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let i = 0; i < total; i += 64) {
    const m = new Int32Array(16);
    for (let j = 0; j < 16; j++) m[j] = view.getInt32(i + j * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let j = 0; j < 64; j++) {
      let f;
      let g;
      if (j < 16) {
        f = (b & c) | (~b & d);
        g = j;
      } else if (j < 32) {
        f = (d & b) | (~d & c);
        g = (5 * j + 1) % 16;
      } else if (j < 48) {
        f = b ^ c ^ d;
        g = (3 * j + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * j) % 16;
      }
      f = (f + a + MD5_K[j] + m[g]) | 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotl(f, MD5_S[j])) | 0;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setInt32(0, a0, true);
  ov.setInt32(4, b0, true);
  ov.setInt32(8, c0, true);
  ov.setInt32(12, d0, true);
  return hex(out);
}

function xtime(a) {
  return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
}

function keyExpansion(key) {
  const w = new Uint8Array(176);
  w.set(key, 0);
  for (let i = 4; i < 44; i++) {
    const t = [w[(i - 1) * 4], w[(i - 1) * 4 + 1], w[(i - 1) * 4 + 2], w[(i - 1) * 4 + 3]];
    if (i % 4 === 0) {
      const r = t[0];
      t[0] = t[1];
      t[1] = t[2];
      t[2] = t[3];
      t[3] = r;
      for (let j = 0; j < 4; j++) t[j] = SBOX[t[j]];
      t[0] ^= RCON[i / 4 - 1];
    }
    for (let j = 0; j < 4; j++) w[i * 4 + j] = w[(i - 4) * 4 + j] ^ t[j];
  }
  return w;
}

function addRoundKey(state, w, round) {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) state[c * 4 + r] ^= w[round * 16 + c * 4 + r];
  }
}

function subBytes(state) {
  for (let i = 0; i < 16; i++) state[i] = SBOX[state[i]];
}

function shiftRows(s) {
  const t = s.slice();
  const map = [0, 5, 10, 15, 4, 9, 14, 3, 8, 13, 2, 7, 12, 1, 6, 11];
  for (let i = 0; i < 16; i++) s[i] = t[map[i]];
}

function mixColumns(s) {
  for (let c = 0; c < 4; c++) {
    const i = c * 4;
    const a0 = s[i];
    const a1 = s[i + 1];
    const a2 = s[i + 2];
    const a3 = s[i + 3];
    s[i] = xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3;
    s[i + 1] = a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3;
    s[i + 2] = a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3);
    s[i + 3] = (xtime(a0) ^ a0) ^ a1 ^ a2 ^ xtime(a3);
  }
}

export function aesCbcEncrypt(plain, key) {
  const w = keyExpansion(key);
  const padLen = 16 - (plain.length % 16);
  const data = new Uint8Array(plain.length + padLen);
  data.set(plain, 0);
  for (let i = plain.length; i < data.length; i++) data[i] = padLen;
  const out = new Uint8Array(data.length);
  const block = new Uint8Array(16);
  let prev = key.slice(0, 16);
  for (let off = 0; off < data.length; off += 16) {
    for (let i = 0; i < 16; i++) block[i] = data[off + i] ^ prev[i];
    addRoundKey(block, w, 0);
    for (let round = 1; round < 10; round++) {
      subBytes(block);
      shiftRows(block);
      mixColumns(block);
      addRoundKey(block, w, round);
    }
    subBytes(block);
    shiftRows(block);
    addRoundKey(block, w, 10);
    out.set(block, off);
    prev = block.slice(0, 16);
  }
  return out;
}

// globalqwenwork 变体：国际站 gateway.qwenwork.ai，协议与 cn 逐字同构（2026-10-01 现网取证），仅命名空间与常量不同 — 见 docs/adr/0041-globalqwenwork-international-provider.md
