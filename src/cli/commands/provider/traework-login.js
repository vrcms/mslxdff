// mslxdff -provider traework login — 复刻 traework2api login.sh。
// 随机 hex16 machine/device id → 构造 trae.cn 授权链接 → 打印 → stdin 读回调链接 →
// 解析 refreshToken/userInfo/userJwt → ExchangeToken → GetUserInfo → 落盘 → 自动签到+查积分。
import { randomBytes } from "node:crypto";
import { compatFetch, timeoutSignal } from "../../../compat.js";
import { CLIENT_ID, IDE_VERSION, OAUTH_HOST } from "../../../providers/traework/constants.js";
import { normalizeExpiresAt } from "../../../providers/traework/token.js";

const API_HOST = OAUTH_HOST;
const APP_VERSION = IDE_VERSION;

function hex(n) { return randomBytes(n).toString("hex"); }

function readStdinLine(prompt) {
  return new Promise((resolve) => {
    try { process.stdout.write(`${prompt}`); } catch {}
    let data = "";
    const onData = (chunk) => { data += String(chunk || ""); if (data.includes("\n")) done(); };
    const done = () => {
      try { process.stdin.removeListener("data", onData); } catch {}
      try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch {}
      try { process.stdin.pause(); } catch {}
      resolve(data.trim());
    };
    try {
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", onData);
      process.stdin.on("end", done);
    } catch { resolve(""); }
  });
}
export function buildLoginUrl({ machineId, deviceId, traceId = hex(8) } = {}) {
  const params = new URLSearchParams({
    login_version: "1",
    auth_from: "solo",
    login_channel: "native_ide",
    plugin_version: "2.3.62834",
    auth_type: "local",
    client_id: CLIENT_ID,
    redirect: "0",
    login_trace_id: traceId,
    auth_callback_url: "http://127.0.0.1:18080/authorize",
    machine_id: machineId,
    device_id: deviceId,
    x_device_id: deviceId,
    x_machine_id: machineId,
    x_device_brand: "PC",
    x_device_type: "PC",
    x_os_version: "1.0",
    x_app_version: APP_VERSION,
    x_app_type: "stable",
  });
  return `https://www.trae.cn/authorization?${params.toString()}`;
}

// 解析回调链接：parse_qs + 双层 unquote 容错 → { refreshToken, userInfo, userJwt }。
export function parseCallbackUrl(url) {
  let u;
  try { u = new URL(String(url || "").trim()); } catch { throw new Error("回调链接不是合法 URL，请复制浏览器地址栏完整链接"); }
  const qs = u.searchParams;
  const rawRefresh = qs.get("refreshToken") || "";
  const parseJsonParam = (raw) => {
    if (!raw) return {};
    for (const v of [raw, decodeURIComponent(raw)]) {
      try { const o = JSON.parse(v); if (o && typeof o === "object") return o; } catch {}
    }
    return {};
  };
  const userInfo = parseJsonParam(qs.get("userInfo") || "");
  const userJwt = parseJsonParam(qs.get("userJwt") || "");
  let refreshToken = rawRefresh || String(userJwt.RefreshToken || "");
  return {
    refreshToken,
    userInfo: { uid: String(userInfo.UserID || ""), nickname: String(userInfo.ScreenName || ""), enterpriseId: String(userInfo.TenantID || "") },
    userJwt: { token: String(userJwt.Token || ""), refreshToken: String(userJwt.RefreshToken || ""), expiresAt: Number(userJwt.TokenExpireAt) || 0 },
  };
}

async function postJson(fetchImpl, url, obj, headers = {}) {
  const res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": `Trae/${APP_VERSION}`, ...headers }, body: JSON.stringify(obj), signal: timeoutSignal(30000) });
  const txt = await res.text();
  let j;
  try { j = JSON.parse(txt); } catch { throw new Error(`上游返回非 JSON: ${txt.slice(0, 200)}`); }
  if (res.status >= 400) throw new Error(`上游 HTTP ${res.status}: ${txt.slice(0, 200)}`);
  return j;
}

export async function handleTraeworkLogin(id, sub, rest = [], deps = {}) {
  if (String(id || "").toLowerCase() !== "traework") return false;
  if (sub !== "login" && sub !== "auth" && sub !== "oauth") return false;
  const fetchImpl = deps.fetchImpl || compatFetch;
  const log = deps.log || ((m) => console.log(m));
  const machineId = hex(16);
  const deviceId = hex(16);
  const loginUrl = buildLoginUrl({ machineId, deviceId });
  log("=".repeat(60));
  log("  TRAE SOLO 登录");
  log("=".repeat(60));
  log("");
  log("  1. 在浏览器打开下面链接，用手机号/验证码登录");
  log("  2. 登录成功后浏览器会跳到打不开的 127.0.0.1 地址");
  log("  3. 复制浏览器地址栏的完整链接，粘贴到下面");
  log("");
  log(`  ${loginUrl}`);
  log("");
  let callback;
  if (deps.callbackUrl) callback = deps.callbackUrl;
  else callback = await readStdinLine("登录完成后，请粘贴浏览器地址栏的完整回调链接: ");
  if (!callback || !String(callback).trim()) { console.error("未输入回调链接，已取消"); process.exit(1); }
  const parsed = parseCallbackUrl(callback);
  let token = "";
  let refreshToken = parsed.refreshToken;
  let expiresAt = 0;
  if (refreshToken) {
    const resp = await postJson(fetchImpl, `${API_HOST}/cloudide/api/v3/trae/oauth/ExchangeToken`, { ClientID: CLIENT_ID, RefreshToken: refreshToken, ClientSecret: "-", UserID: "" });
    const result = resp?.Result || {};
    token = result.Token || "";
    if (!token) { console.error(`ExchangeToken 失败: ${JSON.stringify(resp).slice(0, 300)}`); process.exit(1); }
    refreshToken = result.RefreshToken || refreshToken;
    expiresAt = normalizeExpiresAt(result.TokenExpireAt || 0);
    if (!(expiresAt > Math.floor(Date.now() / 1000))) expiresAt = Math.floor(Date.now() / 1000) + (Number(result.TokenExpireDuration) || 1209600);
    log("ExchangeToken 成功");
  } else {
    token = parsed.userJwt.token;
    expiresAt = normalizeExpiresAt(parsed.userJwt.expiresAt);
    if (!token) { console.error("回调链接缺少 refreshToken，且 userJwt 也没有 Token"); process.exit(1); }
    log("无 refreshToken，使用 userJwt 的 Token 兜底");
  }
  let uid = parsed.userInfo.uid;
  let nickname = parsed.userInfo.nickname;
  let enterpriseId = parsed.userInfo.enterpriseId;
  try {
    const ui = await postJson(fetchImpl, `${API_HOST}/cloudide/api/v3/trae/GetUserInfo`, { ReqSource: "IDE", IDEVersion: APP_VERSION }, { "x-cloudide-token": token });
    const u = ui?.Result || ui || {};
    if (u.UserID) { uid = String(u.UserID); nickname = String(u.ScreenName || nickname); enterpriseId = String(u.EnterpriseID || enterpriseId); }
  } catch (e) { log(`GetUserInfo 失败（使用回调 userInfo）: ${e.message}`); }
  if (!uid) { console.error("未能获取 uid，请检查 token 是否有效"); process.exit(1); }
  const { saveTraeworkAccount } = await import("../../../providers/traework/account-store.js");
  const save = deps.saveAccount || saveTraeworkAccount;
  const saved = await save({ uid, enterpriseId, nickname, accessToken: token, refreshToken, expiresAt, domain: "trae.cn", apiHost: API_HOST, machineId, deviceId });
  // 自动签到 + 查积分
  try {
    const { checkinStatus, checkinClaim, entUsage } = await import("../../../providers/traework/checkin.js");
    const cred = { accessToken: token, deviceId };
    const st = await checkinStatus({ cred, fetchImpl });
    log(`签到状态: checked_in=${st.checkedIn} credits=${st.credits} enable=${st.enable}`);
    if (!st.checkedIn && st.enable) {
      await checkinClaim({ cred, fetchImpl });
      log("签到: success");
    }
    const ent = await entUsage({ cred, fetchImpl });
    log(`当前积分: ${ent.remain}`);
  } catch (e) { log(`签到/查积分: ${String(e?.message || e).slice(0, 200)}`); }
  log("");
  log("=".repeat(60));
  log("  登录完成！");
  log(`  UID: ${uid}`);
  log(`  Nickname: ${nickname || "（未获取到）"}`);
  log(`  账号数: ${saved.accounts}`);
  log("=".repeat(60));
  log("下一步：mslxdff -restart（用户终端跑），然后 mslxdff -provider traework models 验证");
  if (!deps.noExit) process.exit(0);
  return true;
}

// 手动签到：-provider traework checkin
export async function handleTraeworkCheckin(id, sub, rest = [], deps = {}) {
  if (String(id || "").toLowerCase() !== "traework") return false;
  if (sub !== "checkin") return false;
  const fetchImpl = deps.fetchImpl || compatFetch;
  const log = deps.log || ((m) => console.log(m));
  const { loadProviderConfig, loadProviderKeys, defaultStateFile } = await import("../../../state.js");
  const cfg = loadProviderConfig("traework");
  const keys = deps.keys || loadProviderKeys("traework");
  const authList = deps.auths || cfg?.auths || [];
  if (!keys.length || !authList.length) { console.error("没有 traework 账号，请先 mslxdff -provider traework login"); process.exit(1); }
  const { checkinStatus, checkinClaim, entUsage } = await import("../../../providers/traework/checkin.js");
  for (let i = 0; i < Math.min(keys.length, authList.length); i++) {
    const auth = authList[i];
    const at = keys[i];
    if (!auth?.uid || !at) continue;
    const cred = { accessToken: at, deviceId: auth?.deviceId || "", uid: auth.uid };
    log(`账号 ${auth.uid.slice(0, 8)}...`);
    try {
      const st = await checkinStatus({ cred, fetchImpl });
      log(`  签到状态: checked_in=${st.checkedIn} credits=${st.credits} enable=${st.enable}`);
      if (!st.checkedIn && st.enable) {
        await checkinClaim({ cred, fetchImpl });
        log(`  签到: success`);
        const st2 = await checkinStatus({ cred, fetchImpl });
        log(`  签到后积分: ${st2.credits}`);
      }
      const ent = await entUsage({ cred, fetchImpl });
      log(`  总积分: ${ent.remain}`);
    } catch (e) {
      log(`  失败: ${String(e?.message || e).slice(0, 120)}`);
    }
  }
  if (!deps.noExit) process.exit(0);
  return true;
}
