// DPoP（RFC 9449）证明 JWT：ES256 + P-256，供 STS /v1/oauth2/tokens 请求头使用。
// refresh_token 与首次换取时的 DPoP 公钥绑定：私钥 JWK 必须随凭证持久化（d 字段），
// 换新私钥刷新会被 STS 拒（400 invalid refresh token: InvalidDPoPHeader）。
// 算法对齐 HITZY2002/codearts2api internal/upstream/dpop.go。
import crypto from "node:crypto";

// P-256 阶 n（用于低 S 归一化：s > n/2 → s = n - s，jose 默认低 S 兼容性更好）。
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

const b64url = (data) => Buffer.from(data).toString("base64url");

/** 生成可持久化的 DPoP 私钥 JWK（kty/crv/x/y/d，均 base64url 无 padding）。 */
export function newDpopPrivateJwk() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pub = publicKey.export({ format: "jwk" });
  const priv = privateKey.export({ format: "jwk" });
  return { kty: "EC", crv: "P-256", x: pub.x, y: pub.y, d: priv.d };
}

export function dpopPublicJwk(privateJwk) {
  return { kty: "EC", crv: "P-256", x: privateJwk?.x || "", y: privateJwk?.y || "" };
}

export function isValidDpopJwk(jwk) {
  return !!jwk && jwk.kty === "EC" && jwk.crv === "P-256" && typeof jwk.d === "string" && jwk.d.length > 0 && !!jwk.x && !!jwk.y;
}

/** 从持久化 JWK 恢复私钥对象（非法材料直接抛错，调用方须提示重新登录）。 */
export function dpopPrivateKey(jwk) {
  if (!isValidDpopJwk(jwk)) throw new Error("codearts: invalid DPoP private JWK — re-login required");
  try {
    return crypto.createPrivateKey({ key: { ...jwk }, format: "jwk" });
  } catch (err) {
    throw new Error(`codearts: DPoP private JWK unusable (${err?.message || err}) — re-login required`);
  }
}

/** 低 S 归一化：ieee-p1363 64 字节 r||s 原地修正 s（合法：ECDSA (r, n-s) 等价）。 */
function normalizeLowS(sig) {
  if (sig.length !== 64) return sig;
  const s = BigInt("0x" + sig.subarray(32, 64).toString("hex"));
  const half = P256_N >> 1n;
  if (s <= half || s === 0n) return sig;
  const fixed = P256_N - s;
  Buffer.from(fixed.toString(16).padStart(64, "0"), "hex").copy(sig, 32);
  return sig;
}

/**
 * 生成 DPoP proof JWT。
 * @param {object} privateJwk 持久化私钥 JWK（含 d）
 * @param {string} htu 目标端点完整 URL（STS token 端点）
 * @returns {string} `b64(header).b64(payload).b64(sig)` 三段 JWT
 */
export function signDpopProof(privateJwk, htu) {
  const key = dpopPrivateKey(privateJwk);
  const header = { alg: "ES256", typ: "dpop+jwt", jwk: dpopPublicJwk(privateJwk) };
  const payload = {
    htm: "POST",
    htu: String(htu || ""),
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomBytes(32).toString("hex"),
  };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  // 标准 JWS/ES256：对 ASCII(input) 做 SHA256+ECDSA（crypto.sign("SHA256", input)）。
  // 注意：千万别用 sign(null, sha256(input))——OpenSSL 的 noneWithECDSA 把 digest 当整数标量，
  // 签出来自验能过、但任何标准验签方（含 WebCrypto/华为 STS）都拒签（真机 400 STS5.1804 实锤）。
  const sig = normalizeLowS(crypto.sign("SHA256", Buffer.from(input, "utf8"), { key, dsaEncoding: "ieee-p1363" }));
  return `${input}.${b64url(sig)}`;
}

/** 验签辅助（测试/诊断用）：校验 JWT 签名是否与 JWK 公钥匹配。 */
export function verifyDpopProof(proof) {
  const parts = String(proof || "").split(".");
  if (parts.length !== 3) return { ok: false };
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const sig = Buffer.from(parts[2], "base64url");
    const pub = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: header.jwk.x, y: header.jwk.y }, format: "jwk" });
    const input = Buffer.from(`${parts[0]}.${parts[1]}`, "utf8");
    const s = BigInt("0x" + sig.subarray(32, 64).toString("hex"));
    // 标准 JWS/ES256 验签（与签名端对称；dsaEncoding 必须显式 ieee-p1363，node 默认 DER）。
    const vopts = { dsaEncoding: "ieee-p1363" };
    const ok = crypto.verify("SHA256", input, { key: pub, ...vopts }, sig)
      || (s > P256_N >> 1n && crypto.verify("SHA256", input, { key: pub, ...vopts }, (() => {
        const alt = Buffer.from(sig);
        Buffer.from((P256_N - s).toString(16).padStart(64, "0"), "hex").copy(alt, 32);
        return alt;
      })()));
    return { ok, header, payload };
  } catch {
    return { ok: false };
  }
}
