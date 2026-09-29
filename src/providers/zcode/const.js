// zcode 供应商常量单一源：网关地址、客户端版本、业务码表、Start/Coding Plan 模型目录。
// 端点契约调研自 zai-org/ZCode 源码（official-coding-plan-gateway.ts / zcodeEndpoint.ts）与 zcode-switch 实测。
export const ZCODE_ORIGIN = "https://zcode.z.ai";
export const ZCODE_CLI_INIT_URL = `${ZCODE_ORIGIN}/api/v1/oauth/cli/init`;
export const zcodeCliPollUrl = (flowId) =>
  `${ZCODE_ORIGIN}/api/v1/oauth/cli/poll/${encodeURIComponent(String(flowId || ""))}`;
export const ZCODE_MESSAGES_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/anthropic/v1/messages`;
export const zcodeBalanceUrl = (appVersion) =>
  `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/balance?app_version=${encodeURIComponent(String(appVersion || ""))}`;

export const ZCODE_DEFAULT_APP_VERSION = "3.11.2";
export const ZCODE_RELEASE_CHANNEL = "stable";

export function zcodeAppVersion(env = process.env) {
  const v = typeof env?.MSLXDFF_ZCODE_APP_VERSION === "string" ? env.MSLXDFF_ZCODE_APP_VERSION.trim() : "";
  return v || ZCODE_DEFAULT_APP_VERSION;
}

// 业务码表（zcode-switch quota.rs classify + ZCode 客户端 model-execution.ts 实测）：
// 401/1006 鉴权失效，1005 额度耗尽（data/plan/ends_at 为下次时间），限流组，3007 安全校验拒绝。
export const ZCODE_ERROR_KINDS = {
  401: "auth",
  1006: "auth",
  1005: "quota",
  3002: "rate_limit",
  3008: "rate_limit",
  3009: "rate_limit",
  3010: "rate_limit",
  3007: "security",
  2007: "server",
  3001: "param",
  3006: "param",
  3102: "param",
};

export function zcodeErrorKind(code) {
  const n = Number(code);
  return ZCODE_ERROR_KINDS[n] || "unknown";
}

// 官方 canonical id（quota.rs BUILTIN_*_MODELS）；入站大小写不敏感，出站规范化为该表内的写法。
export const ZCODE_CODING_PLAN_MODELS = ["GLM-5.3", "GLM-5.3-Flash"];
export const ZCODE_START_PLAN_MODELS = ["GLM-5.3-Flash", "GLM-5.2", "GLM-5-Turbo"];
export const ZCODE_MODEL_CATALOG = [...new Set([...ZCODE_CODING_PLAN_MODELS, ...ZCODE_START_PLAN_MODELS])];

export function canonicalZcodeModel(id) {
  let raw = String(id || "").trim();
  if (raw.startsWith("zcode/")) raw = raw.slice(6);
  const low = raw.toLowerCase();
  for (const m of ZCODE_MODEL_CATALOG) {
    if (m.toLowerCase() === low) return m;
  }
  return raw;
}
