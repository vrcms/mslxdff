// raccoon（商汤小浣熊）供应商常量单一源：网关地址、客户端版本与 UA、两档思考、业务码表、兜底模型目录。
// 端点契约调研自 Ebony-Vinyl/dsh-our-free-model 的 vendor/channel-pack/src/raccoon*.ts
// （打包产物 pack.js 原文）并逐条本机实测：站点根 200、model_catalog 匿名 401、
// chat/completions 匿名 401、login_with_qrcode_code 匿名 200 {"code":0,"data":{"status":"pending"}}。
export const RACCOON_ORIGIN = "https://xiaohuanxiong.com";

export const RACCOON_LLM_PREFIX = "/api/web/llm/v2";
export const RACCOON_AUTH_PREFIX = "/api/web/auth/v1";
export const RACCOON_POINTS_PREFIX = "/api/web/points/v1";
export const RACCOON_DESKTOP_PREFIX = "/api/web/desktop/v1";

export const raccoonModelCatalogUrl = () => `${RACCOON_ORIGIN}${RACCOON_LLM_PREFIX}/model_catalog`;
export const raccoonChatUrl = () => `${RACCOON_ORIGIN}${RACCOON_LLM_PREFIX}/chat/completions`;
export const raccoonQrLoginUrl = () => `${RACCOON_ORIGIN}${RACCOON_AUTH_PREFIX}/login_with_qrcode_code`;
export const raccoonRefreshUrl = () => `${RACCOON_ORIGIN}${RACCOON_AUTH_PREFIX}/refresh`;
export const raccoonUserInfoUrl = () => `${RACCOON_ORIGIN}${RACCOON_AUTH_PREFIX}/user_info`;
export const raccoonBalanceUrl = () => `${RACCOON_ORIGIN}${RACCOON_POINTS_PREFIX}/balance`;
export const raccoonBillsUrl = (limit = 50) =>
  `${RACCOON_ORIGIN}${RACCOON_POINTS_PREFIX}/bills?paging.limit=${Number(limit) || 50}&paging.offset=0`;
export const raccoonLoginGrantUrl = () => `${RACCOON_ORIGIN}${RACCOON_DESKTOP_PREFIX}/login/points/grant`;

/**
 * 扫码登录深链接：终端编成二维码，**必须用微信「扫一扫」**打开确认（浏览器直接打开会 404）。
 * 形如 `https://xiaohuanxiong.com/login/mp?code=<hex>&appname=商汤小浣熊官网`。
 * 实测：服务器对任意路径都回同一份 SPA 外壳（HTTP 200），但 SPA 路由表里没有 `login/mp`（只有 `login` + 兜底 `*`）→ 浏览器必 404，属正常而非链接失效。
 */
export const raccoonQrPageUrl = (code) =>
  `${RACCOON_ORIGIN}/login/mp?code=${encodeURIComponent(String(code || ""))}&appname=${encodeURIComponent("商汤小浣熊官网")}`;

export const RACCOON_DEFAULT_CLIENT_VERSION = "v1.0.35";
export const RACCOON_CLIENT_PLATFORM = "desktop-windows";
export const RACCOON_CLIENT_LANGUAGE = "zh";
export const RACCOON_LOGIN_REWARD_POINTS = 3000;
export const RACCOON_LOGIN_REWARD_EVENT_NAME = "桌面端登录奖励";

export const RACCOON_REQUEST_TIMEOUT_MS = 60_000;
export const RACCOON_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
export const RACCOON_LOGIN_POLL_INTERVAL_MS = 2000;

/** 客户端版本号（env 可覆盖：上游按版本做风控判断，硬编码会随官方发版失效）。 */
export function raccoonClientVersion(env = process.env) {
  const v = typeof env?.MSLXDFF_RACCOON_CLIENT_VERSION === "string" ? env.MSLXDFF_RACCOON_CLIENT_VERSION.trim() : "";
  return v || RACCOON_DEFAULT_CLIENT_VERSION;
}

/** UA 形如 `Raccoon Work/1.0.35 (Windows)` —— 版本段不带 `v` 前缀（对齐官方客户端字面量）。 */
export function raccoonUserAgent(env = process.env) {
  const ver = raccoonClientVersion(env).replace(/^v/i, "");
  return `Raccoon Work/${ver} (Windows)`;
}

// 思考只有两档（上游不认 reasoning_effort，实测传该参数无可测差异）：
// 出站经 extra_body.thinking.type = "enabled" | "disabled"。
export const RACCOON_EFFORT_ON = "on";
export const RACCOON_EFFORT_OFF = "off";
export const RACCOON_EFFORTS = [RACCOON_EFFORT_ON, RACCOON_EFFORT_OFF];
export const RACCOON_DEFAULT_EFFORT = RACCOON_EFFORT_ON;

/**
 * 思考档位 → 出站 `thinking.type`。
 * 上层档位词表跨供应商共用，收到非本家档位（high/xhigh/max/…）时归一为「开」而非报错。
 */
export function raccoonThinkingType(effort) {
  const raw = String(effort ?? "").trim().toLowerCase();
  if (raw === RACCOON_EFFORT_OFF || raw === "none" || raw === "off") return "disabled";
  return "enabled";
}

/**
 * 思考开关的环境默认：`MSLXDFF_RACCOON_THINKING=off|0|false|no|disabled` 关，其余（含未设）=开。
 * 优先级见 `chat.js` 的 `buildRaccoonWireBody`（请求体显式声明 > effort 参数 > 本 env > 默认开）。
 */
export function raccoonEffortFromEnv(env = process.env) {
  const raw = typeof env?.MSLXDFF_RACCOON_THINKING === "string" ? env.MSLXDFF_RACCOON_THINKING.trim().toLowerCase() : "";
  return raw === "off" || raw === "0" || raw === "false" || raw === "no" || raw === "disabled" ? RACCOON_EFFORT_OFF : RACCOON_EFFORT_ON;
}

/** 冷却档位（对齐 qoder/zcode 先例：限流短冷、额度长冷）。 */
export const RACCOON_DEFAULT_COOLDOWN_MS = 30_000;
export const RACCOON_DEFAULT_QUOTA_COOLDOWN_MS = 60 * 60 * 1000;

// 业务码表（pack.js 实证）：200001 未带 token，200003 登录态过期，100006 图形验证码失败（仅短信链路）。
export const RACCOON_ERROR_KINDS = {
  200001: "auth",
  200003: "auth",
  100006: "captcha",
};

export function raccoonErrorKind(code) {
  return RACCOON_ERROR_KINDS[Number(code)] || "unknown";
}

/**
 * 兜底模型目录（pack.js `RACCOON_FALLBACK_MODELS` 原文，全部支持读图）。
 * `multiplier` = 每次调用扣分倍率：0 免费、1 基准、0.25 四分之一；`baseMultiplier` 存在即促销（显示 x基→x实）。
 * 上游 `model_catalog` 不可达时用本表，保证「未登录也能看见这家有什么」。
 */
export const RACCOON_FALLBACK_MODELS = [
  { id: "sn-sensenova-6-8-flash", contextWindow: 256_000, maxTokens: 63_999, supportsImage: true, multiplier: 0 },
  { id: "sn-sensenova-6-8-flash-lite", contextWindow: 256_000, maxTokens: 63_999, supportsImage: true, multiplier: 0 },
  { id: "sn-kimi-k3", contextWindow: 1_000_000, maxTokens: 100_000, supportsImage: true, multiplier: 1 },
  { id: "sn-deepseek-v4-1-flash", contextWindow: 1_000_000, maxTokens: 100_000, supportsImage: true, multiplier: 0.25 },
  { id: "sn-glm-5-3", contextWindow: 1_000_000, maxTokens: 100_000, supportsImage: true, multiplier: 0.75 },
  { id: "sn-glm-5-3-flash", contextWindow: 1_000_000, maxTokens: 100_000, supportsImage: true, multiplier: 0.1, baseMultiplier: 0.2 },
];

/** 入站 `raccoon/<model>` → 裸 id（allowlist 与出站都用裸 id）。 */
export function canonicalRaccoonModel(id) {
  const raw = String(id || "").trim();
  return raw.startsWith("raccoon/") ? raw.slice("raccoon/".length) : raw;
}
