// ExchangeToken 刷新（照抄 traework2api internal/upstream/client.go refreshLocked）。
import { CLIENT_ID, EP_EXCHANGE, IDE_VERSION, OAUTH_HOST } from "./constants.js";
import { oauthHeaders } from "./headers.js";

// TokenExpireAt 毫秒 → Unix 秒归一（毫秒 ~1.7e12，秒 ~1.7e9，用 1e12 区分）。
export function normalizeExpiresAt(v) {
  const n = Number(v) || 0;
  return n > 1e12 ? Math.floor(n / 1000) : n;
}

export async function exchangeRefresh(fetchImpl, apiHost, refreshToken, { timeoutMs = 30_000 } = {}) {
  const rt = String(refreshToken || "").trim();
  if (!rt) throw new Error("no refreshToken");
  const host = String(apiHost || "").trim().replace(/\/+$/, "") || OAUTH_HOST;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error("traework ExchangeToken timed out")), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  let res;
  try {
    res = await fetchImpl(`${host}${EP_EXCHANGE}`, {
      method: "POST",
      headers: oauthHeaders(),
      body: JSON.stringify({ ClientID: CLIENT_ID, RefreshToken: rt, ClientSecret: "-", UserID: "" }),
      signal: ctl.signal,
    });
  } finally { clearTimeout(timer); }
  const txt = await res.text().catch(() => "");
  if (res.status >= 400) throw Object.assign(new Error(`exchange failed: http ${res.status} ${txt.slice(0, 200)}`), { status: res.status, body: txt });
  let j;
  try { j = JSON.parse(txt); } catch { throw new Error(`exchange parse: non-JSON ${txt.slice(0, 200)}`); }
  const result = j?.Result || {};
  if (!result.Token) throw new Error("refresh_failed: no token in response — re-login required");
  let expiresAt = 0;
  if (Number(result.TokenExpireAt) > 0) expiresAt = normalizeExpiresAt(result.TokenExpireAt);
  else if (Number(result.TokenExpireDuration) > 0) expiresAt = Math.floor(Date.now() / 1000) + Number(result.TokenExpireDuration);
  return { token: result.Token, refreshToken: result.RefreshToken || rt, expiresAt };
}

export async function fetchUserInfo(fetchImpl, apiHost, accessToken, { timeoutMs = 30_000 } = {}) {
  const host = String(apiHost || "").trim().replace(/\/+$/, "") || OAUTH_HOST;
  const res = await fetchImpl(`${host}/cloudide/api/v3/trae/GetUserInfo`, {
    method: "POST",
    headers: { ...oauthHeaders(), "X-Cloudide-Token": accessToken || "" },
    body: JSON.stringify({ ReqSource: "IDE", IDEVersion: IDE_VERSION }),
  });
  const txt = await res.text().catch(() => "");
  if (res.status >= 400) throw Object.assign(new Error(`userinfo failed: http ${res.status}`), { status: res.status });
  let j;
  try { j = JSON.parse(txt); } catch { throw new Error("userinfo parse: non-JSON"); }
  const r = j?.Result || j || {};
  return { uid: String(r.UserID || ""), nickname: String(r.ScreenName || ""), enterpriseId: String(r.EnterpriseID || "") };
}
