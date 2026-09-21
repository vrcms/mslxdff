// qoder OAuth 设备授权（转译 qoder2api account/oauth.go）：
// 1. startLogin: PKCE(S256) + nonce → 返回授权链接
// 2. pollDeviceToken: 轮询 deviceToken/poll，404=未授权继续，200={token:dt-xxx, refresh_token:drt-xxx}
// 3. fetchUserInfo: GET /api/v1/userinfo（Bearer dt-xxx）→ uid/name/organization_id
import { randomBytes, createHash } from "node:crypto";
import { compatFetch, timeoutSignal } from "../../compat.js";
import { OAUTH_CLIENT_ID, getEndpoints } from "./constants.js";

const POLL_MS = 3000;
export const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 对齐 qoder2api 10 分钟

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function hex16() {
  return randomBytes(16).toString("hex");
}

export function buildLoginUrl({ region = "global", nonce, challenge } = {}) {
  const ep = getEndpoints(region);
  const params = new URLSearchParams({
    nonce,
    challenge,
    challenge_method: "S256",
    client_id: OAUTH_CLIENT_ID,
  });
  return `${ep.deviceLoginBase}?${params.toString()}`;
}

// 单次轮询：404/空 token → 未授权（返回 null）；200 且有 token → bundle；5xx → 抛错。
export async function pollDeviceToken({ region = "global", nonce, verifier, fetchImpl = compatFetch } = {}) {
  const ep = getEndpoints(region);
  const url = `${ep.pollEndpoint}?nonce=${encodeURIComponent(nonce)}&verifier=${encodeURIComponent(verifier)}&challenge_method=S256`;
  let res;
  try {
    res = await fetchImpl(url, { signal: timeoutSignal(20000) });
  } catch (e) {
    throw new Error(`轮询失败: ${e.message}`);
  }
  if (res.status === 404) return null; // 还没授权
  if (res.status >= 500) throw new Error(`deviceToken 端点故障: HTTP ${res.status}`);
  const txt = await res.text().catch(() => "");
  let j;
  try { j = JSON.parse(txt); } catch { throw new Error(`deviceToken 返回非 JSON: ${txt.slice(0, 200)}`); }
  const deviceToken = String(j.token || "");
  if (!deviceToken) return null;
  return { deviceToken, refreshToken: String(j.refresh_token || "") };
}

// userinfo：ResolveOAuthUserID 优先 id/userId/uid（qoder2api bridge.go）。
export async function fetchUserInfo({ region = "global", deviceToken, fetchImpl = compatFetch } = {}) {
  const ep = getEndpoints(region);
  const res = await fetchImpl(ep.userinfoBase, {
    headers: { Authorization: `Bearer ${deviceToken}` },
    signal: timeoutSignal(20000),
  });
  const txt = await res.text().catch(() => "");
  let j;
  try { j = JSON.parse(txt); } catch { throw new Error(`userinfo 返回非 JSON: HTTP ${res.status} ${txt.slice(0, 200)}`); }
  if (!res.ok) throw new Error(`userinfo HTTP ${res.status}: ${txt.slice(0, 200)}`);
  const uid = String(j.id || j.userId || j.uid || "");
  if (!uid) throw new Error(`userinfo 无 uid: ${txt.slice(0, 200)}`);
  return {
    uid,
    name: String(j.name || ""),
    email: String(j.email || ""),
    userType: String(j.userType || j.user_type || "personal_standard"),
    organizationId: String(j.organization_id || ""),
    organizationName: String(j.organization_name || ""),
  };
}

// 轮询直到授权成功，返回 bundle；超时抛错。deps.log 便于测试注入。
export async function waitForAuth({ region, nonce, verifier, fetchImpl = compatFetch, log = console.log, deadline = Date.now() + POLL_TIMEOUT_MS } = {}) {
  for (;;) {
    if (Date.now() > deadline) throw new Error("授权超时（10 分钟），请重新运行 mslxdff -provider qoder login");
    const bundle = await pollDeviceToken({ region, nonce, verifier, fetchImpl });
    if (bundle) return bundle;
    await new Promise((r) => setTimeout(r, POLL_MS));
    try { process.stdout.write("."); } catch {}
  }
}