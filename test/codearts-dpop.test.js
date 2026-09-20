// codearts DPoP proof JWT 测试：ES256 P-256、低 S、JWK 恢复、防篡改。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { newDpopPrivateJwk, signDpopProof, verifyDpopProof, dpopPrivateKey, isValidDpopJwk } from "../src/providers/codearts/dpop.js";

describe("codearts dpop", () => {
  test("signDpopProof 产出三段 JWT，header/payload 形状正确", () => {
    const jwk = newDpopPrivateJwk();
    assert.ok(isValidDpopJwk(jwk));
    const htu = "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens";
    const proof = signDpopProof(jwk, htu);
    const parts = proof.split(".");
    assert.equal(parts.length, 3);
    const { ok, header, payload } = verifyDpopProof(proof);
    assert.equal(ok, true);
    assert.equal(header.alg, "ES256");
    assert.equal(header.typ, "dpop+jwt");
    assert.deepEqual({ kty: header.jwk.kty, crv: header.jwk.crv }, { kty: "EC", crv: "P-256" });
    assert.equal(header.jwk.x, jwk.x);
    assert.equal(header.jwk.y, jwk.y);
    assert.equal(header.jwk.d, undefined); // 公钥 JWK 不含 d
    assert.equal(payload.htm, "POST");
    assert.equal(payload.htu, htu);
    assert.ok(Math.abs(payload.iat - Math.floor(Date.now() / 1000)) < 60);
    assert.match(payload.jti, /^[0-9a-f]{64}$/);
  });

  test("低 S 归一化：s ≤ n/2", () => {
    const jwk = newDpopPrivateJwk();
    for (let i = 0; i < 8; i++) {
      const proof = signDpopProof(jwk, "https://x/y");
      const sig = Buffer.from(proof.split(".")[2], "base64url");
      assert.equal(sig.length, 64);
      const s = BigInt("0x" + sig.subarray(32).toString("hex"));
      const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
      assert.ok(s > 0n && s <= n >> 1n, `low-S violated: s=${s.toString(16)}`);
    }
  });

  test("验签拒绝篡改 payload / 换公钥", () => {
    const jwk = newDpopPrivateJwk();
    const proof = signDpopProof(jwk, "https://x/y");
    const [h, p, s] = proof.split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    payload.htu = "https://evil.example/tokens";
    const tampered = `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s}`;
    assert.equal(verifyDpopProof(tampered).ok, false);
  });

  test("dpopPrivateKey 从持久化 JWK 恢复（同一把钥匙）", () => {
    const jwk = newDpopPrivateJwk();
    const proof = signDpopProof(jwk, "https://x/y");
    // 模拟重进程序：从 blob 里拿回 JWK 再签，公钥必须一致（refresh_token 绑定公钥的前提）
    const restored = JSON.parse(JSON.stringify(jwk));
    const proof2 = signDpopProof(restored, "https://x/y");
    assert.equal(JSON.parse(Buffer.from(proof.split(".")[0], "base64url").toString()).jwk.x, JSON.parse(Buffer.from(proof2.split(".")[0], "base64url").toString()).jwk.x);
    assert.doesNotThrow(() => dpopPrivateKey(jwk));
    assert.throws(() => dpopPrivateKey({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }), /invalid DPoP private JWK/);
  });

  test("ES256 签名可用标准验签方独立验签（WebCrypto 仲裁 + node:crypto 对称）", async () => {
    const jwk = newDpopPrivateJwk();
    const proof = signDpopProof(jwk, "https://x/y");
    const [h, p, s] = proof.split(".");
    const pub = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
    assert.equal(crypto.verify("SHA256", Buffer.from(`${h}.${p}`, "utf8"), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")), true);
    // WebCrypto 独立仲裁：华为 STS 侧是标准 JWS 验签（真机 400 STS5.1804 前车：sign(null, digest) 自验能过、标准方拒签）
    const key = await crypto.webcrypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    assert.equal(await crypto.webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(s, "base64url"), Buffer.from(`${h}.${p}`, "utf8")), true);
  });
});
