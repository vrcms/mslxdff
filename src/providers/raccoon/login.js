// raccoon 扫码登录状态机与会话续期。
// 实测依据：`POST /api/web/auth/v1/login_with_qrcode_code` **匿名可达**（HTTP 200 {"code":0,"data":{"status":"pending"}}），
// 故整条登录链路不需要验证码、不需要浏览器组件（短信登录才要阿里云滑块，本期不做）。
import { randomBytes } from "node:crypto";
import {
  RACCOON_LOGIN_POLL_INTERVAL_MS,
  RACCOON_LOGIN_TIMEOUT_MS,
  RACCOON_REQUEST_TIMEOUT_MS,
  raccoonQrLoginUrl,
  raccoonQrPageUrl,
  raccoonRefreshUrl,
  raccoonUserInfoUrl,
} from "./const.js";
import { raccoonAnonymousHeaders, raccoonAuthHeaders } from "./headers.js";
import { decodeJwtExpMs } from "./auth.js";
import { parseRaccoonEnvelope, raccoonEnvelopeText } from "./envelope.js";

/** 上游 `data.status` 四态（pack.js RACCOON_QR_STATUS 同形）。 */
export const RACCOON_QR_STATUS = Object.freeze({
  pending: "pending",
  logging: "logging",
  canceled: "canceled",
  success: "success",
});

/** 一次性登录码：16 字节 hex（32 字符），既是二维码内容参数也是轮询凭据。 */
export function createQrCode() {
  return randomBytes(16).toString("hex");
}

/** 二维码/链接内容：用户用手机扫码或直接打开它完成确认。 */
export function buildQrUrl(code) {
  return raccoonQrPageUrl(code);
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postJson(url, body, { fetchImpl = fetch, env = process.env, timeoutMs = RACCOON_REQUEST_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: raccoonAnonymousHeaders({ env }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`raccoon: 请求失败：${error?.message ?? error}`);
  }
  let parsed;
  try {
    parsed = await res.json();
  } catch {
    throw new Error(`raccoon: 响应不是 JSON（HTTP ${res.status}）`);
  }
  return parseRaccoonEnvelope(parsed, res.status);
}

/** 从登录成功信封里取凭据；缺 access_token 视为失败（不写半截凭据）。 */
export function raccoonCredentialFromEnvelope(envelope) {
  const data = envelope?.data ?? {};
  const accessToken = typeof data.access_token === "string" ? data.access_token : "";
  if (!accessToken) throw new Error("raccoon: 登录响应缺少 access_token");
  const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : "";
  const officeIdentity = typeof data.office_identity === "string" ? data.office_identity : "";
  const expMs = decodeJwtExpMs(accessToken);
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    ...(expMs === undefined ? {} : { expires_at: String(expMs) }),
    ...(officeIdentity ? { office_identity: officeIdentity } : {}),
  };
}

/**
 * 轮询一轮。网络抖动一律折成 `pending`（用户还在扫码，不该因为一次超时把整轮打断）；
 * `canceled` / `success` 是终态。
 */
export async function pollQrLoginOnce(code, opts = {}) {
  let envelope;
  try {
    envelope = await postJson(raccoonQrLoginUrl(), { qrcode_code: String(code || "") }, opts);
  } catch {
    return { status: RACCOON_QR_STATUS.pending };
  }
  if (envelope.code !== 0 || envelope.data === undefined) return { status: RACCOON_QR_STATUS.pending };
  const status = typeof envelope.data.status === "string" ? envelope.data.status : "";
  const expiredAt = typeof envelope.data.expired_at === "string" ? envelope.data.expired_at : undefined;
  if (status === RACCOON_QR_STATUS.canceled) return { status: RACCOON_QR_STATUS.canceled };
  if (status === RACCOON_QR_STATUS.logging) return { status: RACCOON_QR_STATUS.logging, ...(expiredAt ? { expiredAt } : {}) };
  if (status === RACCOON_QR_STATUS.success) {
    try {
      return { status: RACCOON_QR_STATUS.success, credential: raccoonCredentialFromEnvelope(envelope) };
    } catch {
      return { status: RACCOON_QR_STATUS.pending };
    }
  }
  return { status: RACCOON_QR_STATUS.pending };
}

/**
 * 轮询直到终态。返回 `{ status, credential? }`；
 * 超时返回 `{ status: "timeout" }`（调用方据此输出人话并非零退出）。
 */
export async function pollQrLogin(code, {
  fetchImpl = fetch,
  env = process.env,
  intervalMs = RACCOON_LOGIN_POLL_INTERVAL_MS,
  timeoutMs = RACCOON_LOGIN_TIMEOUT_MS,
  onTick,
  sleepFn = defaultSleep,
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  let ticks = 0;
  for (;;) {
    const result = await pollQrLoginOnce(code, { fetchImpl, env });
    ticks += 1;
    if (typeof onTick === "function") {
      try { onTick(result, ticks); } catch {}
    }
    if (result.status === RACCOON_QR_STATUS.success) return result;
    if (result.status === RACCOON_QR_STATUS.canceled) return { status: RACCOON_QR_STATUS.canceled };
    if (now() >= deadline) return { status: "timeout" };
    await sleepFn(intervalMs);
  }
}

/**
 * 用 refresh_token 续期。上游不返回新 refresh_token 时沿用旧的（不能覆盖成空串）。
 * 登录态失效（HTTP 401 / code 200003）抛带 `authExpired` 标记的错误，交由调用方转成重登指引。
 */
export async function refreshRaccoonCredential(credential, opts = {}) {
  const { fetchImpl = fetch, env = process.env, timeoutMs = RACCOON_REQUEST_TIMEOUT_MS } = opts;
  let res;
  try {
    res = await fetchImpl(raccoonRefreshUrl(), {
      method: "POST",
      headers: raccoonAnonymousHeaders({ env }),
      body: JSON.stringify({ refresh_token: String(credential?.refresh_token ?? "") }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`raccoon: 续期请求失败：${error?.message ?? error}`);
  }
  let parsed;
  try {
    parsed = await res.json();
  } catch {
    throw new Error(`raccoon: 续期响应不是 JSON（HTTP ${res.status}）`);
  }
  const envelope = parseRaccoonEnvelope(parsed, res.status);
  if (res.status === 401 || envelope.code === 200003) {
    const err = new Error("raccoon: 登录态已过期，请重新登录");
    err.authExpired = true;
    throw err;
  }
  if (envelope.code !== 0) throw new Error(`raccoon: 续期失败：${raccoonEnvelopeText(envelope)}`);
  const accessToken = typeof envelope.data?.access_token === "string" ? envelope.data.access_token : "";
  if (!accessToken) throw new Error("raccoon: 续期响应缺少 access_token");
  const nextRefresh = typeof envelope.data.refresh_token === "string" && envelope.data.refresh_token.length > 0
    ? envelope.data.refresh_token
    : String(credential?.refresh_token ?? "");
  const expMs = decodeJwtExpMs(accessToken);
  return {
    ...credential,
    access_token: accessToken,
    refresh_token: nextRefresh,
    ...(expMs === undefined ? {} : { expires_at: String(expMs) }),
  };
}

/** 取用户信息（uid/昵称/手机号/office_identity）；任何失败都返回空对象，不阻断登录。 */
export async function fetchRaccoonUserInfo(credential, opts = {}) {
  const { fetchImpl = fetch, env = process.env, timeoutMs = RACCOON_REQUEST_TIMEOUT_MS } = opts;
  try {
    const res = await fetchImpl(raccoonUserInfoUrl(), {
      method: "GET",
      headers: raccoonAuthHeaders(credential, { env }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return {};
    const envelope = parseRaccoonEnvelope(await res.json(), res.status);
    if (envelope.code !== 0 || envelope.data === undefined) return {};
    const pick = (k) => (typeof envelope.data[k] === "string" ? envelope.data[k] : "");
    return {
      userId: pick("id"),
      name: pick("name"),
      phone: pick("phone"),
      officeIdentity: pick("office_identity"),
    };
  } catch {
    return {};
  }
}
