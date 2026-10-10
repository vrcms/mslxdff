// raccoon 出站请求头：与官方客户端同形（逐字段对齐 pack.js 的 raccoonHeaders）。
// 风控按版本/头判断，形态错会 401/403 —— 所以这里不做「优化」，只做照抄。
import {
  RACCOON_CLIENT_LANGUAGE,
  RACCOON_CLIENT_PLATFORM,
  raccoonClientVersion,
  raccoonUserAgent,
} from "./const.js";

/** 匿名头：登录轮询等不需要 token 的调用（官方客户端在这些路径也不带 Authorization）。 */
export function raccoonAnonymousHeaders({ env = process.env, accept = "application/json" } = {}) {
  return {
    Accept: accept,
    "Content-Type": "application/json",
    "User-Agent": raccoonUserAgent(env),
    "X-Raccoon-Language": RACCOON_CLIENT_LANGUAGE,
    "X-Client-Platform": RACCOON_CLIENT_PLATFORM,
    "X-Client-Version": raccoonClientVersion(env),
  };
}

/**
 * 带 token 的出站头。
 * - `X-Org-Code`：个人号为空串（官方客户端总是发送该头）。
 * - `X-Client-Device-ID`：**为空则不发**（个人号可选；被网关拒时的退化路径）。
 * - `X-Client-Version` / `User-Agent` 走 env 可配（见 const.js）。
 */
export function raccoonAuthHeaders(credential, { env = process.env, accept = "application/json", version } = {}) {
  const headers = {
    Accept: accept,
    "Content-Type": "application/json",
    Authorization: `Bearer ${String(credential?.access_token ?? "")}`,
    "X-Org-Code": String(credential?.office_identity ?? ""),
    "X-Raccoon-Language": RACCOON_CLIENT_LANGUAGE,
    "X-Client-Platform": RACCOON_CLIENT_PLATFORM,
    "X-Client-Version": version || raccoonClientVersion(env),
    "User-Agent": raccoonUserAgent(env),
  };
  const deviceId = String(credential?.device_id ?? "").trim();
  if (deviceId) headers["X-Client-Device-ID"] = deviceId;
  return headers;
}

/** 聊天的 Accept 要比 JSON 宽：上游流式与非流式共用同一端点。 */
export const RACCOON_CHAT_ACCEPT = "text/event-stream, application/json";
