// qoder 设备指纹派生（转译 qoder2api internal/cosy/fingerprint.go + session.go）
// fingerprint: 由 seed（uid 优先，无 uid 用 credential）派生 machineId/machineToken/machineType
import { createHash, randomBytes } from "node:crypto";

export function fingerprintSeed(uid, credential) {
  if (uid) return uid;
  return "cred:" + credential;
}

export function deriveMachineId(seed) {
  return createHash("md5").update("machine:" + seed).digest("hex");
}

export function deriveMachineType(seed) {
  return createHash("md5").update("machinetype:" + seed).digest("hex").slice(0, 18);
}

export function deriveMachineToken(seed) {
  const sum = createHash("sha512").update("machinetoken:" + seed).digest();
  return sum.toString("base64url").slice(0, 43);
}

export function newUUID() {
  const b = randomBytes(16);
  const hex = b.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
}

export function newRequestId() {
  return randomBytes(12).toString("hex");
}

export function unixSec() {
  return Math.floor(Date.now() / 1000);
}

export function unixMs() {
  return Date.now();
}