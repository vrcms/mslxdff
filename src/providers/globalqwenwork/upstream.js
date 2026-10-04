// upstream.js（签名请求装配 + OAuth 设备流）— vendor 自 src/providers/qwenwork/upstream.js 逐字搬；
// URL 全部来自本目录 constants.js（BASE=.ai），client_id/redirect_uri 自动取国际站值。
import { compatFetch } from "../../compat.js";
import { uuid, b64url, utf8 } from "./crypto.js";
import { signHeaders } from "./cosy.js";
import {
  UA, CLIENT_ID, REDIRECT_URI, DEVICE_AUTH_URL, CHAT_URL, MODELS_URL,
  USERINFO_URL, ACCOUNT_CONTEXT_URL, POLL_URL, REFRESH_URL, MODEL_SLICE,
} from "./constants.js";

function plainHeaders() {
  return {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    "user-agent": UA,
  };
}

export function chatRequest(account, modelKey, bodyStr, signal, fetchImpl = compatFetch) {
  const headers = signHeaders(account, bodyStr, CHAT_URL, modelKey, "text/event-stream");
  return fetchImpl(CHAT_URL, { method: "POST", headers, body: bodyStr, signal });
}

export async function modelList(account, fetchImpl = compatFetch) {
  const headers = signHeaders(account, "", MODELS_URL, "", "application/json");
  const res = await fetchImpl(MODELS_URL, { headers });
  if (!res.ok) throw new Error(`models http ${res.status}`);
  const data = await res.json();
  // 实测 11 个根切片只有 `qwork` 非空（其余 n=0）；切片名见 constants.MODEL_SLICE
  const list = Array.isArray(data && data[MODEL_SLICE]) ? data[MODEL_SLICE] : [];
  return list
    .filter((m) => m && m.enable !== false && m.key)
    .map((m) => ({
      key: m.key,
      name: m.display_name || m.key,
      isReasoning: !!m.is_reasoning,
      isVL: !!m.is_vl,
      maxInputTokens: m.max_input_tokens || 0,
      maxOutputTokens: m.max_output_tokens || 0,
      priceFactor: typeof m.price_factor === "number" ? m.price_factor : 0,
      description: typeof m.description === "string" ? m.description : "",
    }));
}

export async function userInfo(accessToken, fetchImpl = compatFetch) {
  const res = await fetchImpl(USERINFO_URL, {
    headers: { ...plainHeaders(), authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`userinfo http ${res.status}`);
  return res.json();
}

/** 额度/套餐：data.{user,plan,quota}；quota.remaining 即积分余量。 */
export async function accountContext(accessToken, fetchImpl = compatFetch) {
  const res = await fetchImpl(ACCOUNT_CONTEXT_URL, {
    headers: { ...plainHeaders(), authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`account-context http ${res.status}`);
  const body = await res.json();
  if (!body || (body.code && body.code !== "ok")) throw new Error(`account-context code=${body && body.code}`);
  return (body && body.data) || {};
}

export async function refreshDeviceToken(refreshToken, fetchImpl = compatFetch) {
  const res = await fetchImpl(REFRESH_URL, {
    method: "POST",
    headers: plainHeaders(),
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) throw new Error(`refresh http ${res.status}`);
  const data = await res.json();
  const access = data && (data.token || data.device_token);
  if (!access || !data.refresh_token) throw new Error("refresh: incomplete token pair");
  return data;
}

export async function pollGrant(nonce, verifier, fetchImpl = compatFetch) {
  const q = new URLSearchParams({ nonce, verifier, challenge_method: "S256" });
  const res = await fetchImpl(`${POLL_URL}?${q.toString()}`, {
    headers: { accept: "application/json", "user-agent": UA },
  });
  if (res.status === 404 || res.status === 202) return { pending: true };
  if (!res.ok) throw new Error(`poll http ${res.status}`);
  const data = await res.json();
  if (!data || !(data.token || data.device_token)) return { pending: true };
  return { pending: false, grant: data };
}

export async function newDeviceFlow() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const raw = new Uint8Array(64);
  crypto.getRandomValues(raw);
  let verifier = "";
  for (let i = 0; i < raw.length; i++) verifier += alphabet[raw[i] % alphabet.length];
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(verifier)));
  const challenge = b64url(digest);
  const nonce = uuid();
  const machineID = uuid();
  const q = new URLSearchParams({
    challenge,
    challenge_method: "S256",
    nonce,
    machine_id: machineID,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
  });
  return { verifier, nonce, url: `${DEVICE_AUTH_URL}?${q.toString()}` };
}

export function expiryUnix(grant) {
  if (grant && grant.expires_at) {
    const t = Date.parse(grant.expires_at);
    if (!Number.isNaN(t)) return Math.floor(t / 1000);
  }
  if (grant && grant.expires_in > 0) {
    const ms = grant.expires_in > 10000000 ? grant.expires_in : grant.expires_in * 1000;
    return Math.floor((Date.now() + ms) / 1000);
  }
  return Math.floor((Date.now() + 30 * 24 * 3600 * 1000) / 1000);
}

// globalqwenwork 变体（国际站 gateway.qwenwork.ai）：协议与 cn 逐字同构，2026-10-01 现网实测签名/请求 200 — 见 docs/adr/0041-globalqwenwork-international-provider.md
