// STS /v1/oauth2/tokens：授权码换凭证 + refresh_token 续期（DPoP 必带）。
// 终态失效（refresh_token 过期/已用/DPoP 或 client_id 不匹配）→ relogin=true，
// 与网络/5xx 瞬时失败分开，避免好号被误杀或死号无限刷。
import { STS_HOST, EP_OAUTH_TOKENS, CLIENT_ID } from "./const.js";
import { signDpopProof } from "./dpop.js";
import { compatFetch } from "../../compat.js";

function tokenErr(rawText) {
  try { return JSON.parse(rawText) || {}; } catch { return {}; }
}

// 对齐 codearts2api：invalid_grant / ExpiredRefreshToken / InvalidDPoPHeader /
// invalid client id / has been used → 终态，必须重新登录。
export function isReLoginRejected(status, rawText) {
  const t = tokenErr(rawText);
  const code = String(t.error_code || "");
  const msg = String(t.error_msg || "");
  const low = (t.error || msg).toLowerCase();
  return t.error === "invalid_grant"
    || code.includes("ExpiredRefreshToken")
    || code.includes("InvalidDPoPHeader")
    || low.includes("invalid client id")
    || low.includes("has been used");
}

/** 归一化 STS 响应（新 credentials / 旧 credential 双形状）。 */
export function normalizeTokenResponse(json) {
  const c = json?.credentials || {};
  const legacy = json?.credential || {};
  const securityToken = c.security_token || legacy.securitytoken || "";
  const accessKeyId = c.access_key_id || legacy.access || "";
  const secretAccessKey = c.secret_access_key || legacy.secret || "";
  const expiration = c.expiration || legacy.expires_at || "";
  if (!securityToken || !accessKeyId || !secretAccessKey) return null;
  const expiresAtMs = expiration ? Date.parse(expiration) : NaN;
  return {
    userId: String(json.user_id || ""),
    userName: String(json.user_name || ""),
    domainId: String(json.domain_id || ""),
    refreshToken: String(json.refresh_token || ""),
    accessKeyId,
    secretAccessKey,
    securityToken,
    expiration,
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : 0,
  };
}

async function postToken({ url, form, dpopJwk, fetchImpl }) {
  const doFetch = fetchImpl || compatFetch;
  const proof = signDpopProof(dpopJwk, url);
  const res = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", dpop: proof },
    body: form.toString(),
  });
  const raw = await res.text().catch(() => "");
  return { res, raw };
}

/**
 * 授权码换凭证（登录用）。
 * @param {object} p { code, verifier, redirectUri, clientId?, dpopJwk, fetchImpl?, stsHost? }
 */
export async function exchangeAuthorizationCode({ code, verifier, redirectUri, clientId = CLIENT_ID, dpopJwk, fetchImpl, stsHost } = {}) {
  const url = (stsHost || STS_HOST) + EP_OAUTH_TOKENS;
  const form = new URLSearchParams({
    client_id: clientId,
    code: String(code || ""),
    code_verifier: String(verifier || ""),
    grant_type: "authorization_code",
    redirect_uri: String(redirectUri || ""),
  });
  const { res, raw } = await postToken({ url, form, dpopJwk, fetchImpl });
  if (res.status >= 400) throw new Error(`codearts sts exchange http ${res.status}: ${String(raw).slice(0, 200)}`);
  const json = JSON.parse(raw);
  const account = normalizeTokenResponse(json);
  if (!account) throw new Error("codearts sts exchange: response missing credentials");
  account.clientId = clientId;
  return account;
}

/**
 * 用 refresh_token 换新 STS 凭证（refresh_token 单次轮换，响应里取新值写回）。
 * @param {object} blob 账号凭证 blob（refreshToken/codeVerifier/dpopJwk/clientId）
 * @param {object} [opts] { fetchImpl, stsHost }
 * @returns {{account, refreshToken?, relogin?, error?}}
 */
export async function refreshStsCredential(blob, { fetchImpl, stsHost } = {}) {
  const refreshToken = String(blob?.refreshToken || "");
  const verifier = String(blob?.codeVerifier || "");
  const jwk = blob?.dpopJwk;
  const clientId = String(blob?.clientId || CLIENT_ID);
  if (!refreshToken) return { account: null, relogin: true, error: "missing refresh_token" };
  if (!verifier) return { account: null, relogin: true, error: "missing code_verifier" };
  if (!jwk || !jwk.d) return { account: null, relogin: true, error: "missing DPoP private key — re-login required" };

  const url = (stsHost || STS_HOST) + EP_OAUTH_TOKENS;
  const form = new URLSearchParams({
    client_id: clientId,
    code_verifier: verifier,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  let res, raw;
  try {
    ({ res, raw } = await postToken({ url, form, dpopJwk: jwk, fetchImpl }));
  } catch (err) {
    return { account: null, error: `network: ${err?.message || err}` };
  }
  if (res.status >= 400) {
    if (isReLoginRejected(res.status, raw)) {
      const t = tokenErr(raw);
      return { account: null, relogin: true, status: res.status, code: t.error_code, error: `refresh rejected: ${String(raw).slice(0, 200)}` };
    }
    return { account: null, status: res.status, error: `sts http ${res.status}: ${String(raw).slice(0, 200)}` };
  }
  let json;
  try { json = JSON.parse(raw); } catch { return { account: null, error: "sts returned non-JSON body" }; }
  const account = normalizeTokenResponse(json);
  if (!account) return { account: null, error: "sts response missing credentials" };
  account.clientId = clientId;
  return { account, refreshToken: account.refreshToken || null };
}
