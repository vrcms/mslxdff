// raccoon 密码登录（手机号 + 密码）—— 多账号自动化添加的捷径（免扫码）。
// 契约、端点选择理由与「为什么必须加密」见 const.js 的 raccoonPasswordLoginUrl 注释；
// 加密算法与 key 见 crypto.js（单一源）。
//
// ⚠ 安全红线：密码**只作为请求体出现一次**（且出站前已被加密）。本模块不落盘、不打印、不记日志；
//   抛出的错误里也绝不带上请求体原文（上游 message 是它自己的文案，安全）。
import {
  RACCOON_PASSWORD_ERRORS,
  RACCOON_REQUEST_TIMEOUT_MS,
  raccoonPasswordLoginUrl,
} from "./const.js";
import { raccoonAnonymousHeaders } from "./headers.js";
import { isRaccoonOk, parseRaccoonEnvelope, raccoonEnvelopeText } from "./envelope.js";
import { decodeJwtExpMs } from "./auth.js";
import { raccoonEncryptField } from "./crypto.js";

/** nation_code 归一：接受 `"86"` / `"+86"` / `86`，统一成不带加号的数字串。 */
export function normalizeNationCode(raw) {
  const s = String(raw ?? "").trim().replace(/^\+/, "");
  return /^\d{1,4}$/.test(s) ? s : "";
}

/** 手机号归一：只留数字（去空格、连字符、括号）。空结果由调用方判错。 */
export function normalizePhone(raw) {
  return String(raw ?? "").replace(/[^\d]/g, "");
}

/** 上游登录失败 → 人话 Error。命中码表用它，否则透出上游 message（绝不带请求体）。 */
function passwordLoginError(envelope, status) {
  const key = String(envelope?.code ?? "");
  const friendly = RACCOON_PASSWORD_ERRORS[key];
  const err = new Error(`raccoon: 密码登录失败：${friendly || raccoonEnvelopeText(envelope, `HTTP ${status}`)}`);
  err.code = envelope?.code;
  err.status = status;
  return err;
}

/**
 * 手机号 + 密码 → credential（与扫码登录**同一形状**，可直接喂 saveRaccoonAccount）。
 *
 * 返回 `{ access_token, refresh_token, expires_at?, office_identity? }`；
 * 失败抛「可操作」的错误（码表命中给人话，未命中透出上游文案）。
 * 本地校验先于出网：手机号/密码为空当场报错，不白跑一次请求。
 *
 * ⚠ 出站前 phone/password 都经 `raccoonEncryptField` 加密（上游契约，见 const.js）——
 *   发明文只会换来一句「手机号或密码不正确」，把格式错误伪装成密码错误。
 */
export async function loginRaccoonWithPassword({ phone, password, nationCode = "86" } = {}, {
  fetchImpl = fetch,
  env = process.env,
  timeoutMs = RACCOON_REQUEST_TIMEOUT_MS,
} = {}) {
  const nc = normalizeNationCode(nationCode);
  const ph = normalizePhone(phone);
  if (!nc) throw new Error("raccoon: 国家码不合法（用 86 这类数字，或 +86）");
  if (!ph) throw new Error("raccoon: 手机号不能为空");
  if (String(password ?? "").length === 0) throw new Error("raccoon: 密码不能为空");

  // 未知错误码时透出上游 message 而非裸码 —— 上游新旧通道对同一错误的形态不同：
  // 新 IAM 把 message 放顶层（AUTH_ACCOUNT_OR_PASSWORD_INVALID），旧 web 只有 message/details。
  const body = {
    nation_code: nc,
    phone: raccoonEncryptField(ph),
    password: raccoonEncryptField(String(password)),
  };

  let res;
  try {
    res = await fetchImpl(raccoonPasswordLoginUrl(), {
      method: "POST",
      headers: raccoonAnonymousHeaders({ env }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`raccoon: 密码登录请求失败：${error?.message ?? error}`);
  }

  let parsed;
  try {
    parsed = await res.json();
  } catch {
    throw new Error(`raccoon: 密码登录响应不是 JSON（HTTP ${res.status}）`);
  }
  const envelope = parseRaccoonEnvelope(parsed, res.status);
  // 上游把错误码同时塞在 `code` 与 `message`：web 通道 `{code:"AUTH_...",message:"AUTH_..."}`
  // 时 message 是裸码，不能当人话用 —— 故这里把 code 也纳入，让码表能命中。
  if (!isRaccoonOk(envelope)) throw passwordLoginError(envelope, res.status);

  const data = envelope.data ?? {};
  const accessToken = typeof data.access_token === "string" ? data.access_token : "";
  if (!accessToken) throw new Error("raccoon: 密码登录响应缺少 access_token");
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
