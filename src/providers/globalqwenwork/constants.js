// globalqwenwork（千问办公国际站 gateway.qwenwork.ai）上游技术常量。
// 值来源：2026-10-01 用真号现网取证 —— 设备流/poll/refresh/userinfo/account-context/
// model/list/COSY 签名/chat SSE 全部实测 200（非推测）。**禁止凭记忆改值**；
// 要改先现网复测（客户端一升级这些快照就可能 403）。
// Note: 为何独立 provider 而非 qwenwork 的新 region — 见 docs/adr/0041-globalqwenwork-international-provider.md
export const BASE = "https://gateway.qwenwork.ai";

// OAuth 设备授权。client_id 与 cn 站（qwenwork 的 e883ade2…）**不同**：实测用 cn 的
// client_id + redirect_uri=qwenwork-cn:// 打本域名，selectAccounts 判
// `INVALID_DEVICE_FLOW / field=query / reason=not_allowed`（整串 query 不被接受）。
// 国际版官方客户端硬编码 CONFIGURED_OAUTH_CLIENT_ID=cc65e5fc…（app.asar 取证 + 运行日志实证）。
export const CLIENT_ID = "cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a";
// 深链协议同国际版客户端日志：`qwenwork://`（cn 站是 `qwenwork-cn://`）
export const REDIRECT_URI = "qwenwork://";

export const DEVICE_AUTH_URL = `${BASE}/device/selectAccounts`;
export const POLL_URL = `${BASE}/api/v1/deviceToken/poll`;
export const REFRESH_URL = `${BASE}/api/v1/deviceToken/refresh`;
export const USERINFO_URL = `${BASE}/api/v1/userinfo`;
// 额度/套餐：data.{user,plan,quota}；国际站免费档 pid=`subscription-sgp-free`（新加坡池，与 cn 积分池独立）
export const ACCOUNT_CONTEXT_URL = `${BASE}/api/v1/adapter/user/account-context?include=user,plan,quota`;
// 无 `Encode=1`：请求体走纯 JSON（与 cn 同）
export const CHAT_URL = `${BASE}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common`;
export const MODELS_URL = `${BASE}/algo/api/v2/model/list`;

export function envStr(name, fallback) {
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

// 客户端指纹常量：实测国际站网关接受 cn 同款值（COSY 签名 200），故与 qwenwork 保持一致；
// 官方国际版客户端自身 UA 为 `qwenwork/1.0.4`，如上游开始校验版本可用下列 env 覆盖排障。
export const UA = envStr("MSLXDFF_GLOBALQWENWORK_UA", "qoderwork/1.0.5");
export const COSY_VERSION = envStr("MSLXDFF_GLOBALQWENWORK_COSY_VERSION", "1.1.18");
export const IDE_VERSION = envStr("MSLXDFF_GLOBALQWENWORK_IDE_VERSION", "1.0.5");
export const RELEASE_VERSION = envStr("MSLXDFF_GLOBALQWENWORK_RELEASE_VERSION", "1.0.5-26090901");
export const BUILD = envStr("MSLXDFF_GLOBALQWENWORK_BUILD", "26090901");
export const CLIENT_TYPE = "6";
// 业务归属字段：实测国际站接受 cn 同款 `qoder_work`/`agent`/`qwork`（chat 200 出词）
export const BUSINESS_PRODUCT = "qoder_work";
export const BUSINESS_TYPE = "agent";
export const SCENE = "qwork";
export const MACHINE_OS = "x86_64_win32";

// 上游 model/list 返回 11 个根切片，实测国际站同样**只有 `qwork` 非空**（n=2）；
// 但切片内容与 cn 站**完全不同池**：cn 是 flash/pro/qwen3.8-max-preview，国际站是下面两个。
export const MODEL_SLICE = "qwork";
export const DEFAULT_MODEL = "qwork-auto";
export const CONTEXT_LENGTH = 180000;
export const MAX_TOKENS_DEFAULT = 32000;

// 实测模型池（2026-10-01 真号取证，`/algo/api/v2/model/list` 原文）：
// 两者 is_reasoning=false / is_vl=true / price_factor=0 / max_input_tokens=180000 /
// context_config 1M(默认)|200K|400K；`qwork-auto` 上游实为 qwen3.8-flash，
// `qwork-advanced` 上游实为 gpt-5.6-sol（响应头 X-Model-Name 取证）。仅作取数失败时兜底展示。
export const KNOWN_MODELS = [
  { key: "qwork-auto", name: "Standard｜Qwen3.8-Flash", priceFactor: 0 },
  { key: "qwork-advanced", name: "Advanced", priceFactor: 0 },
];

// RSA-1024 模数：实测国际站接受与 cn **同一枚**模数（COSY 签名 200），逐字符沿用勿改。
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
