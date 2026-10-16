// SOLO 三类请求头（照抄 traework2api internal/upstream/headers.go）。纯函数，可测。
import { APP_ID, DEVICE_BRAND, IDE_VERSION, IDE_VERSION_CODE, OS_VERSION, TRAE_UA, MARKET_UA, MARKET_VSCODE_VERSION, MARKET_USER_REGION, MARKET_SDK_TYPE, MARKET_PACKAGE_TYPE, MARKET_AID, MARKET_APP_VERSION } from "./constants.js";
import { uuid } from "../../compat.js";

// 对话/模型表（Cloud-IDE-JWT 鉴权 + IDE 指纹）。
export function soloHeaders(cred = {}, stream = true) {
  const at = cred?.accessToken || "";
  const h = {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    "User-Agent": TRAE_UA,
    Authorization: `Cloud-IDE-JWT ${at}`,
    "X-Cloudide-Token": at,
    "X-Ide-Token": at,
    "X-App-Id": APP_ID,
    "X-App-Version": "default",
    "X-Ide-Version": IDE_VERSION,
    "X-Ide-Version-Code": IDE_VERSION_CODE,
    "X-App-Version-Code": IDE_VERSION_CODE,
    "X-Ide-Version-Type": "stable",
    "X-Device-Type": "windows",
    "X-OS-Version": OS_VERSION,
    "X-Device-Brand": DEVICE_BRAND,
    "Request-Traffic-Type": "prod",
  };
  if (cred?.uid) h["X-Uid"] = cred.uid;
  if (cred?.machineId) h["X-Machine-Id"] = cred.machineId;
  if (cred?.deviceId) h["X-Device-Id"] = cred.deviceId;
  return h;
}

// 签到/积分/额度（api.trae.cn 的 UG 与 pay 系接口）。
// ⚠ 这套头是**线上契约**：三件设备身份（x-device-id / x-market-user-id / vscode-sessionid）缺一或形态不对，
//   `checkin_credits/claim` 就回 `code=9004 下单参数不正确`（2026-10-15 现网取证）。
//   逐字对齐 NextAgentX/trae-workbuddy-switch `modules/trae/credits.rs:116-147`，取值出处与该仓纪律见 constants.js 注释。
export function ugHeaders(cred = {}) {
  const m = cred?.market || {};
  const at = String(cred?.accessToken || "");
  return {
    accept: "*/*",
    "accept-language": "zh-CN",
    "content-type": "application/json",
    "user-agent": MARKET_UA,
    // 防双前缀：传进来的可能已带 `Cloud-IDE-JWT `（口径同参考实现 jwt.rs:53-61）
    authorization: at.startsWith("Cloud-IDE-JWT ") ? at : `Cloud-IDE-JWT ${at}`,
    "x-market-client-id": `VSCode ${MARKET_VSCODE_VERSION}`,
    "x-market-user-id": String(m.marketUserId || ""),
    "x-user-region": MARKET_USER_REGION,
    "x-device-id": String(m.deviceId || ""),
    "x-lgw-req-sdk-type": MARKET_SDK_TYPE,
    "package-type": MARKET_PACKAGE_TYPE,
    "x-request-id": uuid(),
    "x-lscbd-aid": MARKET_AID,
    "x-lscbd-platform": ugPlatformTag(),
    "app-version": MARKET_APP_VERSION,
    "x-tt-trace-id": ugTraceId(),
    "vscode-sessionid": String(m.sessionId || ""),
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "no-cors",
    "sec-fetch-site": "none",
  };
}

/** `x-lscbd-platform`：按真实平台报，不自称 Windows（参考实现 credits.rs:150-160 的理由：减少跨平台特征矛盾）。 */
export function ugPlatformTag(p = process.platform) {
  if (p === "win32") return "windows";
  if (p === "darwin") return "macos";
  return "linux";
}

/** `x-tt-trace-id` = `00-<uuid 去连字符前 16 位>-01`（参考实现 credits.rs:162-166）。 */
export function ugTraceId(rnd = uuid) {
  return `00-${String(rnd()).replace(/-/g, "").slice(0, 16)}-01`;
}

// ExchangeToken / GetUserInfo（无签名，仅 UA）。
export function oauthHeaders() {
  return { "Content-Type": "application/json", Accept: "application/json", "User-Agent": TRAE_UA };
}
