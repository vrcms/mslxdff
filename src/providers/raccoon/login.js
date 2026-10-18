// raccoon 扫码登录状态机与会话续期。
// ⚠ 2026-10 上游改版（本机实测）：扫码登录**不再是**「客户端自造 code + 旧 web 端点」。
//   新链路 `/api/iam/v1/auth/mp/qrcode` 里 code 由**服务端签发**（`qr-<uuid>`）并下发
//   scan_path / expires_in / poll_interval。旧写法（`randomBytes(16)` 当 code）在新通道下
//   没有服务端会话 —— 微信扫码后查不到该码，症状正是「二维码已过期或已被使用」。
//   新通道同样匿名可达、不需要验证码，故整条链路仍不需要浏览器组件（短信登录才要滑块，本期不做）。
import {
  RACCOON_LOGIN_POLL_INTERVAL_MS,
  RACCOON_LOGIN_TIMEOUT_MS,
  RACCOON_REQUEST_TIMEOUT_MS,
  raccoonIamConfirmUrl,
  raccoonQrCancelUrl,
  raccoonQrCreateUrl,
  raccoonQrPageUrl,
  raccoonQrPollUrl,
  raccoonRefreshUrl,
  raccoonUserInfoUrl,
} from "./const.js";
import { raccoonAnonymousHeaders, raccoonAuthHeaders } from "./headers.js";
import { decodeJwtExpMs } from "./auth.js";
import { isRaccoonOk, parseRaccoonEnvelope, raccoonEnvelopeText } from "./envelope.js";

/** 上游 `data.status` 四态（与网站登录页 chunk 实测一致）。 */
export const RACCOON_QR_STATUS = Object.freeze({
  pending: "pending",
  logging: "logging",
  canceled: "canceled",
  success: "success",
});

/** 码在服务端不存在/已作废时 IAM 通道回的业务码。 */
export const RACCOON_QR_EXPIRED_CODE = "AUTH_QRCODE_EXPIRED";

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postJson(url, body, { fetchImpl = fetch, env = process.env, timeoutMs = RACCOON_REQUEST_TIMEOUT_MS, method = "POST" } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: { ...raccoonAnonymousHeaders({ env }), "Accept-Language": "zh-CN" },
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

/**
 * 请服务端签发一个二维码会话。
 *
 * 返回 `{ qrcodeCode, scanPath, expiresIn, pollInterval, qrUrl }`。
 * 任何字段不合契约都**抛错**而不是产出降级码 —— 自造 code 正是这次故障的根因，
 * 再"兜底"一个扫不出来的码等于把同一类故障换个说法。
 */
export async function createQrSession(opts = {}) {
  const envelope = await postJson(raccoonQrCreateUrl(), { product_codes: [] }, opts);
  if (!isRaccoonOk(envelope)) throw new Error(`raccoon: 二维码签发失败：${raccoonEnvelopeText(envelope)}`);
  const code = typeof envelope.data?.qrcode_code === "string" ? envelope.data.qrcode_code.trim() : "";
  if (!code) throw new Error("raccoon: 二维码签发响应缺少 qrcode_code");
  const scanPath = typeof envelope.data.scan_path === "string" ? envelope.data.scan_path : "/login/mp";
  const expiresIn = Number(envelope.data.expires_in);
  const pollInterval = Number(envelope.data.poll_interval);
  return {
    qrcodeCode: code,
    scanPath,
    expiresInMs: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : RACCOON_LOGIN_TIMEOUT_MS,
    pollIntervalMs: Number.isFinite(pollInterval) && pollInterval > 0
      ? Math.max(1000, Math.min(60_000, pollInterval * 1000))
      : RACCOON_LOGIN_POLL_INTERVAL_MS,
    qrUrl: raccoonQrPageUrl(code, scanPath),
  };
}

/** 递归渲染用的二维码内容；scanPath 由签发响应给出。 */
export function buildQrUrl(code, scanPath) {
  return raccoonQrPageUrl(code, scanPath);
}

/** 回收服务端会话（过期/退出时调用，失败不影响用户）。 */
export async function cancelQrSession(code, opts = {}) {
  try {
    await postJson(raccoonQrCancelUrl(), { qrcode_code: String(code || ""), status: "canceled" }, { ...opts, method: "PUT" });
  } catch {
    // 取消是礼貌动作，不是流程一部分：网络不通时静默即可（码自己会到期）
  }
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
 * `canceled` / `expired` / `success` 是终态。
 */
export async function pollQrLoginOnce(code, opts = {}) {
  let envelope;
  try {
    envelope = await postJson(raccoonQrPollUrl(), { qrcode_code: String(code || "") }, opts);
  } catch {
    return { status: RACCOON_QR_STATUS.pending };
  }
  if (!isRaccoonOk(envelope)) {
    // 码在服务端不存在/已作废 —— 必须区分出来：继续轮询只会一直失败，用户却以为还在等扫描
    if (String(envelope.code) === RACCOON_QR_EXPIRED_CODE) return { status: "expired" };
    return { status: RACCOON_QR_STATUS.pending };
  }
  if (envelope.data === undefined) return { status: RACCOON_QR_STATUS.pending };
  const status = typeof envelope.data.status === "string" ? envelope.data.status : "";
  const expiredAt = typeof envelope.data.expired_at === "string" ? envelope.data.expired_at : undefined;
  const pollIntervalMs = Number.isFinite(Number(envelope.data.poll_interval)) && Number(envelope.data.poll_interval) > 0
    ? Number(envelope.data.poll_interval) * 1000
    : undefined;
  const jitter = pollIntervalMs === undefined ? {} : { pollIntervalMs };
  if (status === RACCOON_QR_STATUS.canceled) return { status: RACCOON_QR_STATUS.canceled };
  if (status === RACCOON_QR_STATUS.logging) return { status: RACCOON_QR_STATUS.logging, ...jitter, ...(expiredAt ? { expiredAt } : {}) };
  if (status === RACCOON_QR_STATUS.success) {
    try {
      return { status: RACCOON_QR_STATUS.success, ...jitter, credential: raccoonCredentialFromEnvelope(envelope) };
    } catch {
      return { status: RACCOON_QR_STATUS.pending, ...jitter };
    }
  }
  return { status: RACCOON_QR_STATUS.pending, ...jitter };
}

/**
 * 轮询直到终态。返回 `{ status, credential? }`。
 *
 * `deadlineMs` 用**服务端下发的有效期**（不是本地常量）：码的生死由上游决定，
 * 本地猜一个更长的窗口只会在码已作废后继续空转，把「已过期」拖成「超时」。
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
  let interval = intervalMs;
  for (;;) {
    const result = await pollQrLoginOnce(code, { fetchImpl, env });
    ticks += 1;
    if (typeof onTick === "function") {
      try { onTick(result, ticks); } catch {}
    }
    if (result.status === RACCOON_QR_STATUS.success) return result;
    if (result.status === RACCOON_QR_STATUS.canceled) return { status: RACCOON_QR_STATUS.canceled };
    if (result.status === "expired") return { status: "expired" };
    // 服务端可以调快/调慢节奏，以它下发的为准（夹在 1s–60s，防被一个坏值卡住）
    if (Number.isFinite(result.pollIntervalMs)) interval = Math.max(1000, Math.min(60_000, result.pollIntervalMs));
    if (now() >= deadline) return { status: "timeout" };
    await sleepFn(interval);
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
  // 登录态失效判据两代都收：旧通道数字 200003，IAM 通道字符串 AUTH_ACCESS_TOKEN_EXPIRED
  if (res.status === 401 || envelope.code === 200003 || String(envelope.code) === "AUTH_ACCESS_TOKEN_EXPIRED") {
    const err = new Error("raccoon: 登录态已过期，请重新登录");
    err.authExpired = true;
    throw err;
  }
  if (!isRaccoonOk(envelope)) throw new Error(`raccoon: 续期失败：${raccoonEnvelopeText(envelope)}`);
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

/**
 * IAM 会话确认（POST /api/web/auth/v1/iam/confirm，body `{}`，带 Bearer）。
 *
 * 2026-10-18 故障取证：上游新登录的会话未确认前，业务端点一律回
 * `400 {"code":200901,"message":"iam_confirm_required"}`（桌面端旧会话早已确认，
 * 所以官方 App 无感）。官方前端（c6.js）的处理是「撞 200901 → confirm → 重试原请求」，
 * 我们对齐同款：chat.js 兜底重试 + 登录成功后主动确认一次。
 * 返回是否确认成功；任何失败都吞掉返回 false（由调用方的懒重试兜底，绝不阻断主流程）。
 */
export async function confirmRaccoonSession(credential, { fetchImpl = fetch, env = process.env, timeoutMs = RACCOON_REQUEST_TIMEOUT_MS } = {}) {
  try {
    const res = await fetchImpl(raccoonIamConfirmUrl(), {
      method: "POST",
      headers: raccoonAuthHeaders(credential, { env }),
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    });
    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return res.ok && isRaccoonOk(parseRaccoonEnvelope(parsed, res.status));
  } catch {
    return false;
  }
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
    if (!isRaccoonOk(envelope) || envelope.data === undefined) return {};
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
