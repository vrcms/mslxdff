// warp-pool · WireGuard 密钥（`wg genkey` / `wg pubkey` 的 Node 原生等价物）。
// WireGuard 用 Curve25519(x25519)：密钥是 32 字节 raw，编码为 44 字符 base64。
// Node 原生 generateKeyPairSync('x25519') 导出的 DER 末 32 字节即 raw key（本机实测通过）。
import crypto from "node:crypto";

const RAW_BYTES = 32;

/** DER(SPKI/PKCS8) 的末 32 字节就是 Curve25519 raw key。 */
function rawTail(der) {
  const raw = der.subarray(-RAW_BYTES);
  if (raw.length !== RAW_BYTES) throw new Error("x25519 密钥导出异常：DER 长度不足 32 字节");
  return raw;
}

/**
 * 生成一对 WireGuard 密钥（base64，44 字符）。
 * 注册 WARP 设备时把 publicKey 填进请求体的 `key` 字段。
 */
export function generateWgKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  const privateKeyB64 = rawTail(privateKey.export({ type: "pkcs8", format: "der" })).toString("base64");
  const publicKeyB64 = rawTail(publicKey.export({ type: "spki", format: "der" })).toString("base64");
  return { privateKey: privateKeyB64, publicKey: publicKeyB64 };
}

/** WireGuard base64 密钥形状自检：恒 44 字符、以 '=' 收尾（Nothing-up-my-sleeve 检查用）。 */
export function isWgKey(v) {
  return typeof v === "string" && /^[A-Za-z0-9+/]{43}=$/.test(v);
}
