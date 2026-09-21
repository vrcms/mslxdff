// qoder COSY 签名与会话（转译 qoder2api internal/cosy/session.go + signature.go + auth.go）
// 会话：RSA-OAEP 加密 tempKey + AES-CBC 加密身份 payload → cosyKey + info
// 签名：md5(payloadB64 + "\n" + cosyKey + "\n" + date + "\n" + body + "\n" + pathSig)
import { createHash, randomBytes, createCipheriv, publicEncrypt } from "node:crypto";
import { cosyEncode } from "./encode.js";
import { newUUID, unixSec } from "./fingerprint.js";

export const APP_CODE = "cosy";
export const VERSION = "1.0.10";
// base64("war, war never changes")
const SECRET_B64 = "d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==";

const SERVER_PUB_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

export function signLegacy(date) {
  const s = APP_CODE + "&" + SECRET_B64 + "&" + date;
  return createHash("md5").update(s).digest("hex");
}

export function currentDate() {
  return new Date().toUTCString();
}

export function buildPayloadB64(info) {
  const m = JSON.stringify({
    cosyVersion: VERSION,
    ideVersion: "",
    info,
    requestId: newUUID(),
    version: "v1",
  });
  return Buffer.from(m).toString("base64");
}

export function signRequest(payloadB64, cosyKey, cosyDate, body, pathWithoutAlgo) {
  const s = payloadB64 + "\n" + cosyKey + "\n" + cosyDate + "\n" + body + "\n" + pathWithoutAlgo;
  return createHash("md5").update(s).digest("hex");
}

export function composeBearer(payloadB64, sig) {
  return "Bearer COSY." + payloadB64 + "." + sig;
}

export function psfRsaEncrypt(plaintext) {
  return publicEncrypt(
    { key: SERVER_PUB_KEY, padding: 1 }, // PKCS1v15
    plaintext
  );
}

function aesEncrypt(plain, key) {
  const bs = 16;
  const pad = bs - (plain.length % bs);
  const padded = Buffer.alloc(plain.length + pad, pad);
  plain.copy(padded);
  const iv = key.slice(0, bs);
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

export function authPayloadJSON(id) {
  return JSON.stringify({
    name: id.name || "",
    aid: id.aid || "",
    uid: id.uid || "",
    yx_uid: id.yxUid || "",
    organization_id: id.organizationId || "",
    organization_name: id.organizationName || "",
    user_type: id.userType || "personal_standard",
    security_oauth_token: id.securityOauthToken || "",
    refresh_token: id.refreshToken || "",
  });
}

export function newSession(id, machineId, machineToken, machineType) {
  const raw = randomBytes(16);
  const tempKey = Buffer.from(raw.toString("hex").slice(0, 16), "utf8").slice(0, 16);
  // 确保正好 16 字节
  const key16 = Buffer.alloc(16);
  tempKey.copy(key16);

  const cosyKeyBytes = psfRsaEncrypt(key16);
  const cosyKey = cosyKeyBytes.toString("base64");

  const payloadBytes = Buffer.from(authPayloadJSON(id), "utf8");
  const encPayload = aesEncrypt(payloadBytes, key16);
  const info = encPayload.toString("base64");

  return { tempKey: key16, cosyKey, info, identity: id, machineId, machineToken, machineType };
}

// 去除 /algo 前缀的 PathSig
export function pathSigFrom(url) {
  try {
    const u = new URL(url);
    let p = u.pathname;
    if (p.startsWith("/algo")) p = p.slice(5);
    return p;
  } catch {
    return "";
  }
}

// 构造请求头
export function buildCosyHeaders(sess, pathSig, bodyStr, accept) {
  const payloadB64 = buildPayloadB64(sess.info);
  const date = String(unixSec());
  const sig = signRequest(payloadB64, sess.cosyKey, date, bodyStr || "", pathSig);
  const bearer = composeBearer(payloadB64, sig);
  return {
    "cosy-data-policy": "agree",
    "content-type": "application/json",
    "cosy-machinetype": sess.machineType,
    "cosy-clienttype": "5",
    "cosy-date": date,
    "cosy-user": sess.identity.uid,
    "cosy-key": sess.cosyKey,
    "cache-control": "no-cache",
    "accept": accept || "application/json",
    "authorization": bearer,
    "cosy-version": VERSION,
    "cosy-machineid": sess.machineId,
    "cosy-machinetoken": sess.machineToken,
    "login-version": "v2",
    "user-agent": "Go-http-client/2.0",
    "cosy-scene": "assistant",
    "cosy-business-product": "ide",
    "cosy-business-type": "agent",
  };
}