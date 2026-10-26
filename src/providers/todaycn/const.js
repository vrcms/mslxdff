// todaycn（Today AI · 今日工作助手，api.todayai.cn）常量：域名、端点、客户端指纹、轮询与令牌默认值。
// 指纹头复刻桌面端（TodayCN/1.23.0 / Electron 33）——上游按客户端形状判决，缺头可能落不同路由。
// 凭据（refreshCredential）一律不进本文件：落盘见 account-store.js，本机导入见 session.js。

export const TODAYCN_ID = "todaycn";
export const TODAYCN_AUTH_BASE = "https://auth.todayai.cn";
export const TODAYCN_API_BASE = "https://api.todayai.cn";

export const TODAYCN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "TodayCN/1.23.0 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36";

/** 桌面端 X-Client-Capabilities 全量（实测随聊天请求一起发，缺项不影响文本链路，但保持复刻）。 */
export const TODAYCN_CAPABILITIES = [
  "chat.automation_card.v1",
  "chat.brief_card.v1",
  "chat.browser.v1",
  "chat.connector_automation_card.v1",
  "chat.connector_auth_card.v1",
  "chat.follow_up_recommendations.v1",
  "chat.qa_single_select.immediate.v1",
  "chat.qa_cardflow_single.v1",
  "chat.message_reactions.unicode.v1",
  "connectors.account_management.v1",
  "pricing.cn_usage_locked_recovery.v1",
].join(",");

export const TODAYCN_APP_VERSION = "2.0.0";
export const TODAYCN_CLIENT_PLATFORM = "windows";
/** 缺省设备 id：云设备恒在线（真机设备 id 由 auths 文档带，见 account-store.js）。 */
export const TODAYCN_DEFAULT_DEVICE_ID = "d_cloud";

/** 平台模型位前缀：对外剥掉（todaycn/deepseek-v4.1-flash），切设置时补回。 */
export const TODAYCN_MODEL_PREFIX = "model.";
export const TODAYCN_DEFAULT_OPTION = "model.deepseek-v4.1-flash";

export const TODAYCN_POLL_INTERVAL_MS = 2500;
/** 发出后等 final 回复的上限；超时按 empty（本号此刻不出话）换号。 */
export const TODAYCN_POLL_TIMEOUT_MS = 75_000;
/** accessToken 实测 10 分钟 TTL，提前 1 分钟重刷。 */
export const TODAYCN_TOKEN_SKEW_MS = 60_000;

/** 本机客户端数据目录覆盖（自动化/多账号测试用）。 */
export const TODAYCN_DESKTOP_DIR_ENV = "MSLXDFF_TODAYCN_STATE_DIR";

/** 平台 optionId → 对外模型 id（model.deepseek-v4.1-flash → deepseek-v4.1-flash；mode.* 原样留）。 */
export function toGatewayModelId(optionId = "") {
  const raw = String(optionId).trim();
  if (!raw) return "";
  return raw.startsWith(TODAYCN_MODEL_PREFIX) ? raw.slice(TODAYCN_MODEL_PREFIX.length) : raw;
}

/** 对外模型 id → 平台 optionId（幂等：已带 model./mode. 前缀的原样返回）。 */
export function toPlatformOptionId(modelId = "") {
  const raw = String(modelId).trim();
  if (!raw) return "";
  if (raw.startsWith(TODAYCN_MODEL_PREFIX) || raw.startsWith("mode.")) return raw;
  return TODAYCN_MODEL_PREFIX + raw;
}