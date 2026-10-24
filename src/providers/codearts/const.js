// CodeArts Agent 云端 API 常量（逆向自 HITZY2002/codearts2api，源自 vscode-codebot 26.7.0）。
// 端点契约见 docs/adr/0027-codearts-provider.md。

// 盘古引擎/聊天网关（product.json snapEngineDomain，商业版 cn-north-4）。
export const SNAP_BASE = "https://snap-access.cn-north-4.myhuaweicloud.com";
// STS 令牌端点（refresh_token 与 client_id + DPoP 公钥 + code_verifier 三重绑定）。
export const STS_HOST = "https://sts.cn-north-4.myhuaweicloud.com";
// 限时福利（免费套餐）网关（模型发现 + 领取）。
export const BENEFIT_HOST = "https://opengw.developer.huaweicloud.com";
// OAuth authorize 入口（注意带 /portal）。
export const PORTAL_HOST = "https://codearts.huaweicloud.com/portal";

export const EP_CHAT_V2 = "/api/v2/chat/completions";
export const EP_MODEL_BUILTIN = "/v1/model/builtin";
export const EP_AGENT_LIST = "/v1/agent-center/agents/useragents";
export const EP_AGENT_DETAIL = "/v1/agent-center/agents/detail";
export const EP_BENEFIT_CONFIG = "/api/v1/gateway/config";
export const EP_BENEFIT_CLAIM = "/api/v1/benefit/claim";
export const EP_OAUTH_TOKENS = "/v1/oauth2/tokens";
export const EP_LOGIN_TICKET = "/v1/login/ticket";
export const SNAP_MANAGER_PATH = "/snap-manager";

// OAuth client：官方 CodeArts Agent 插件的 uri_scheme；refresh_token 与之绑定。
export const CLIENT_ID = "codearts-agent";
// ticket 轮询的插件标识（逆向自 huaweicloud.authentication 扩展）。
export const PLUGIN_NAME = "snap_AIIDE";
export const PLUGIN_VERSION = "5.2.0";

// 聊天路由头（官方 AgentKernel 形状；均进入 SDK-HMAC-SHA256 签名）。
export function chatBaseHeaders(securityToken, traceId) {
  return {
    "content-type": "application/json",
    "accept": "text/event-stream",
    "x-auth-token": securityToken || "",
    "x-snap-traceid": traceId,
    "x-language": "zh-cn",
    "app-id": "CodeAgent3.0",
    "is_confidential": "false",
  };
}

// 福利路由头：必须在 signRequest 之前设置（计入 SignedHeaders），否则 InferHub.002002009.404。
export const MAAS_TYPE_HEADER = "maas_type";
export const MAAS_BENEFIT = "benefit";

// 冷启动种子：福利套餐轮换后新模型在首次发现前也按福利路由（宁多带不少带，少带即 404）。
// 现网取证 2026-10-16（福利网关 /api/v1/gateway/config，error_code=0000）共 4 位：下列 id 逐字对齐上游。
// 2026-10-24 再取证：`deepseek-v4.1-flash` 已转 builtin 正式模型（福利网关该号已空）。它留在福利种子里
// 是有害的 —— preheat 未回来时带福利头 → InferHub.4004.200 benefit not found，不带才 200。故移出、转入正式表。
export const SEED_BENEFIT_MODELS = ["deepseek-v4-flash-0731", "deepseek-v4-pro-0813", "glm-5.3-flash"];
// 内置模型种子（仅用于大小写归一，不标福利）。id 一律写上游真正的 model_id 大小写：
// `deepseek-v4.1-flash` 是全小写，`GLM-5.2` 就是混合大小写——猜错即 InferHub.002002009.404。
export const SEED_KNOWN_MODELS = [
  // 现网取证 2026-10-24（builtin 路真 model_id 逐字）：这些就是全小写，展示名（OpenPangu-2.0-Pro /
  // GLM-5.3 / Kimi-K3）出自 agent-center 的 model_name，当 id 发上去必 InferHub.002002009.404。
  // 同名漂移记在 name 字段，不占用 id：GLM-5.2-ArkTS-SPARK 的真 id 是 glm-5.2-sft-harmony。
  "deepseek-v4.1-flash", "glm-5.3", "kimi-k3", "openpangu-2.0-pro", "openpangu-2.0-flash",
  "glm-5.2-sft-harmony", "kimi-k2.6-vl",
  "GLM-5.2", "GLM-5.1", "GLM-4.7",
  "Qwen3-VL-235B", "Qwen3.5-397B-A17B-VL", "Qwen3.6-27B-VL",
];

// 目录 TTL：超过则建议重新发现（对齐 codearts2api CatalogTTL）。
export const CATALOG_TTL_MS = 60 * 60 * 1000;
// listModels 缓存（与全仓 10min 对齐）。
export const MODELS_CACHE_TTL_MS = 10 * 60 * 1000;
// STS 凭证提前刷新量（对齐 codearts2api RefreshSkew 30min）。
export const REFRESH_SKEW_MS_DEFAULT = 30 * 60 * 1000;

// 上游 max_tokens 真实上限：福利网关自报 131072~393216 是假的 —— 现网实测 65536 通、
// 98304 即 InferHub.001001005.400（2026-10-16 定位）；此前成功请求均为 64000。
export const MAX_TOKENS_CEILING = 65536;
