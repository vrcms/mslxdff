// qwenwork（千问办公 gateway.qwenwork.cn）上游技术常量。
// 转译自 qwenwork2api-makers 的 edge-functions/_shared/config.js —— **禁止凭记忆改值**；
// 要改先现网复测（客户端一升级这些快照就可能 403）。
// Note: 为何独立 provider 而非 qoder 的新 region — 见 docs/adr/0037-qwenwork-independent-provider.md
export const BASE = "https://gateway.qwenwork.cn";

// OAuth 设备授权。client_id 与 qoder 恰好同值，但**不得 import qoder 常量**：
// 同 client_id 不代表同租户（RSA 模数/模型池/额度池均不同，实测见 ADR-0037）。
export const CLIENT_ID = "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb";
export const REDIRECT_URI = "qwenwork-cn://";

export const DEVICE_AUTH_URL = `${BASE}/device/selectAccounts`;
export const POLL_URL = `${BASE}/api/v1/deviceToken/poll`;
export const REFRESH_URL = `${BASE}/api/v1/deviceToken/refresh`;
export const USERINFO_URL = `${BASE}/api/v1/userinfo`;
// 额度/套餐：data.{user,plan,quota}，quota.remaining 即积分余量（实测新免费号 2099.277）
export const ACCOUNT_CONTEXT_URL = `${BASE}/api/v1/adapter/user/account-context?include=user,plan,quota`;
// 无 `Encode=1`：请求体走**纯 JSON**，不像 qoder 那样过自定义 base64 字母表
export const CHAT_URL = `${BASE}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common`;
export const MODELS_URL = `${BASE}/algo/api/v2/model/list`;

export function envStr(name, fallback) {
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

/** env 可覆盖，排障不必改代码（改后必须现网复测）。 */
export const UA = envStr("MSLXDFF_QWENWORK_UA", "qoderwork/1.0.5");
export const COSY_VERSION = envStr("MSLXDFF_QWENWORK_COSY_VERSION", "1.1.18");
export const IDE_VERSION = envStr("MSLXDFF_QWENWORK_IDE_VERSION", "1.0.5");
export const RELEASE_VERSION = envStr("MSLXDFF_QWENWORK_RELEASE_VERSION", "1.0.5-26090901");
export const BUILD = envStr("MSLXDFF_QWENWORK_BUILD", "26090901");
export const CLIENT_TYPE = "6";
export const BUSINESS_PRODUCT = "qoder_work";
export const BUSINESS_TYPE = "agent";
export const SCENE = "qwork";
export const MACHINE_OS = "x86_64_win32";

// 上游 model/list 返回 11 个根切片，实测**只有 `qwork` 非空**（其余 n=0）：
// chat/developer/assistant/inline/quest/nap/experts/qwake 全 0 —— 与 qoder 的 `chat` 切片零交集。
export const MODEL_SLICE = "qwork";
export const DEFAULT_MODEL = "flash";
export const CONTEXT_LENGTH = 180000;
export const MAX_TOKENS_DEFAULT = 32000;

// 实测模型池（2026-09-29 真号取证）：flash price_factor=0.1 / pro=1 / qwen3.8-max-preview=1.8，
// 三者均 is_reasoning=true、is_vl=true、context_config 1M(默认)/200K/400K。
// 仅作取数失败时的兜底展示，真实目录以 /model/list 为准。
export const KNOWN_MODELS = [
  { key: "flash", name: "标准", priceFactor: 0.1 },
  { key: "pro", name: "高级", priceFactor: 1 },
  { key: "qwen3.8-max-preview", name: "Qwen3.8-Max", priceFactor: 1.8 },
];

// RSA-1024 模数（逐字符转译 _shared/crypto.js 的 RSA_N，勿改）
export const RSA_MODULUS_HEX =
  "c0f22307e5cd362e296bb04470f6de8fbf935ce24e8fcf511a0e2701329769c4" +
  "a76e499bb938036a52af1eaf818cf79a2600620e3ce87e371d2ca6d85803606a" +
  "1b3fa5e874643c9ed2db7e85673ef7227fca56e2e7c08f0927609bb896a9f24b" +
  "e1782099a66016a5bfdc3f1ff756bfc9e88d7b5dc5be30bf45a0223a00ebcecf";
export const RSA_EXPONENT = 65537;

export const LOGIN_TTL_MS = 10 * 60 * 1000;
export const COOLDOWN_MS = 30_000;
export const QUOTA_COOLDOWN_MS = 60 * 60 * 1000;
export const REFRESH_MARGIN_MS = 30 * 60 * 1000;
export const MODELS_CACHE_MS = 10 * 60 * 1000;
