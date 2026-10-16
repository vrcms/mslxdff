// warp-pool · 注册 Cloudflare WARP 设备（换回一份 WireGuard 配置 + 设备 token）。
// API 形状与限流纪律来自同类项目实战（catoncat/warp-pool）+ 本机实测（200 响应字段已核对）。
import crypto from "node:crypto";
import { compatFetch } from "../compat.js";
import { generateWgKeyPair } from "./keys.js";

export const REG_URL = "https://api.cloudflareclient.com/v0a2483/reg";
// 客户端版本头：Cloudflare 换版后旧值会被 403/400 拒（届时换成最新 app 版本号）。
export const CF_CLIENT_VERSION = "a-6.81-2410032352.1";
export const MAX_ATTEMPTS = 4;

export function buildRegisterBody({ publicKey, uuid = crypto.randomUUID(), now = Date.now } = {}) {
  return {
    install_id: "",
    tos: new Date(now()).toISOString().replace(/\.\d{3}Z$/, ".000Z"),
    key: publicKey,
    fcm_token: "",
    serial_number: uuid,
    type: "Android",
    model: "PC",
    locale: "zh_CN",
  };
}

/** 从注册响应抽建隧道所需字段；缺 config/id/token 视为失败。 */
export function parseRegisterResponse(json = {}) {
  const cfg = json?.config;
  const peer = Array.isArray(cfg?.peers) ? cfg.peers[0] : null;
  const addr = cfg?.interface?.addresses || {};
  if (!peer?.public_key || !addr.v4 || !json?.id || !json?.token) {
    throw new Error("注册响应缺少必要字段（config.peers/interface.addresses/id/token）");
  }
  return {
    id: String(json.id),
    token: String(json.token),
    v4: String(addr.v4),
    v6: String(addr.v6 || ""),
    peerKey: String(peer.public_key),
    endpoint: String(peer?.endpoint?.host || "engage.cloudflareclient.com:2408"),
  };
}

/**
 * 退避：429/403 走长退避（短退避会被续封，同类项目 2026-08-18 事故记录），
 * 其它错误（网络层）走短随机退避。
 */
export function backoffMs(status, attempt, rnd = Math.random) {
  if (status === 429 || status === 403) return Math.round(60_000 + rnd() * 60_000);
  return Math.round(12_000 * attempt + 5_000 + rnd() * 3_000);
}

/**
 * 注册一个 WARP 设备。成功返回 { id, token, v4, v6, peerKey, endpoint, privateKey, publicKey }。
 * @param {{ fetchImpl?: Function, keyPair?: {privateKey:string,publicKey:string}, uuid?: string,
 *           now?: () => number, sleep?: (ms:number)=>Promise<void>, log?: (s:string)=>void,
 *           maxAttempts?: number, timeoutMs?: number }} [opts]
 */
export async function registerWarpDevice({
  fetchImpl = compatFetch,
  keyPair = generateWgKeyPair(),
  uuid = crypto.randomUUID(),
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {},
  maxAttempts = MAX_ATTEMPTS,
  timeoutMs = 30_000,
} = {}) {
  const body = buildRegisterBody({ publicKey: keyPair.publicKey, uuid, now });
  let lastStatus = 0;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      const wait = backoffMs(lastStatus, attempt);
      log(`[warp-pool] 注册重试 ${attempt}/${maxAttempts}（上次 HTTP ${lastStatus || "网络错误"}），退避 ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
    let res;
    try {
      res = await fetchImpl(REG_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Client-Version": CF_CLIENT_VERSION,
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      lastStatus = 0;
      lastErr = e;
      continue;
    }
    lastStatus = res.status;
    const text = await res.text().catch(() => "");
    if (res.status !== 200) {
      lastErr = new Error(`HTTP ${res.status}: ${String(text).slice(0, 200)}`);
      continue;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      lastErr = e;
      continue;
    }
    return { ...parseRegisterResponse(json), privateKey: keyPair.privateKey, publicKey: keyPair.publicKey };
  }
  throw new Error(
    `WARP 注册失败（已试 ${maxAttempts} 次，最后 HTTP ${lastStatus || "网络错误"}）：${String(lastErr?.message || lastErr)}`,
  );
}
