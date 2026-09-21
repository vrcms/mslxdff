// SOLO 三类请求头（照抄 traework2api internal/upstream/headers.go）。纯函数，可测。
import { APP_ID, DEVICE_BRAND, IDE_VERSION, IDE_VERSION_CODE, OS_VERSION, TRAE_UA } from "./constants.js";

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

// 签到/积分（api.trae.cn）。
export function ugHeaders(cred = {}) {
  const h = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": TRAE_UA,
    Authorization: `Cloud-IDE-JWT ${cred?.accessToken || ""}`,
    "X-User-Region": "CN",
  };
  if (cred?.deviceId) h["X-Device-Id"] = cred.deviceId;
  return h;
}

// ExchangeToken / GetUserInfo（无签名，仅 UA）。
export function oauthHeaders() {
  return { "Content-Type": "application/json", Accept: "application/json", "User-Agent": TRAE_UA };
}
