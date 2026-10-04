// vendor 自 src/providers/qwenwork/crypto.js 的 RSA 段（BigInt modPow + PKCS#1 v1.5 type-2），逐字搬。
// 模数取 constants.js 的 RSA_MODULUS_HEX（与上游一致，勿改）。
import { b64, utf8 } from "./crypto.js";
import { RSA_MODULUS_HEX, RSA_EXPONENT } from "./constants.js";

export const RSA_N = BigInt("0x" + RSA_MODULUS_HEX);
export const RSA_E = BigInt(RSA_EXPONENT);

function modPow(base, exp, mod) {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

export function rsaPkcs1Encrypt(data, n = RSA_N, e = RSA_E, k = 128) {
  const psLen = k - data.length - 3;
  if (psLen < 8) throw new Error("rsa: message too long");
  const ps = new Uint8Array(psLen);
  for (;;) {
    crypto.getRandomValues(ps);
    let ok = true;
    for (let i = 0; i < psLen; i++) {
      if (ps[i] === 0) {
        ok = false;
        break;
      }
    }
    if (ok) break;
  }
  const em = new Uint8Array(k);
  em[0] = 0x00;
  em[1] = 0x02;
  em.set(ps, 2);
  em[2 + psLen] = 0x00;
  em.set(data, 3 + psLen);
  let m = 0n;
  for (let i = 0; i < k; i++) m = (m << 8n) | BigInt(em[i]);
  const c = modPow(m, e, n);
  const out = new Uint8Array(k);
  let v = c;
  for (let i = k - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b64(out);
}

export { b64, utf8 };

// globalqwenwork 变体：国际站 gateway.qwenwork.ai，协议与 cn 逐字同构（2026-10-01 现网取证），仅命名空间与常量不同 — 见 docs/adr/0041-globalqwenwork-international-provider.md
