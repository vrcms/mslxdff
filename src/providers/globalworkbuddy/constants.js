// globalworkbuddy（WorkBuddy AI 国际站 www.workbuddy.ai）上游技术常量。
// 值来源：2026-10-05 现网取证，逐条证据见 `.scratch/globalworkbuddy/FINDINGS.md` 结论 A/B。
// **禁止凭记忆改值**；要改先现网复测 —— 上游一升级这些快照就可能变（同 `globalqwenwork/constants.js:3` 的纪律）。
// Note: 为何独立 provider 而非 workbuddy 的新 region —— ① 两区模型池几乎无交集（国际版独有 gpt-6 系/gemini-3.8-flash），
//       目录与 allowlist 绝不能跨区互供；② 把 `.ai` 的 token 发给 `copilot.tencent.com` 等于跨产品泄露凭据
//       （参考仓库 auth.ts 对此直接抛 credential-region-mismatch）；③ 两区凭据不可互通。

export function envStr(name, fallback) {
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

/**
 * 国际版是「三区合一」：chat / billing / Origin 全指向同一个 host。
 * 国内版才是 chat=copilot.tencent.com、billing/Origin=www.codebuddy.cn 分开的，别把那个形状搬过来。
 */
export const BASE = envStr("MSLXDFF_GLOBALWORKBUDDY_BASE_URL", "https://www.workbuddy.ai").replace(/\/+$/, "");
export const ORIGIN = BASE;
/** 凭据归属域；判定「这枚凭据属不属于国际版」的依据就是它是否以 `.workbuddy.ai` 结尾。 */
export const DOMAIN = envStr("MSLXDFF_GLOBALWORKBUDDY_DOMAIN", "www.workbuddy.ai");

export function isGlobalDomain(domain) {
  const d = String(domain || "").trim().toLowerCase();
  return d === "workbuddy.ai" || d.endsWith(".workbuddy.ai");
}

// —— 端点（全部现网实测，2026-10-05）——
export const MODELS_PATH = "/v3/config";                        // 200 code=0；国内版的 /console/enterprises/personal/models 在这里恒 **500**
export const CHAT_PATH = "/v2/chat/completions";                // 与国内版同路径
export const REFRESH_PATH = "/v2/plugin/auth/token/refresh";    // 实测路由存在（伪造 token 探得 401/12153「token format error」，非 404）
export const BILLING_PATH = "/v2/billing/meter/get-user-resource";              // 200，`data.Response.Data`，与国内版同形状
export const BILLING_SUMMARY_PATH = "/billing/meter/get-user-resource-summary"; // 200，`data.Packages[]`（容量是**字符串**）
export const AUTH_STATE_PATH = "/v2/plugin/auth/state";         // POST ?platform= → {state, authUrl}
export const AUTH_TOKEN_PATH = "/v2/plugin/auth/token";         // GET ?state= → 轮询
export const LOGIN_ACCOUNT_PATH = "/v2/plugin/login/account";   // GET ?state= → {uid, enterpriseId, nickname}

// ⚠ 参考仓库 issue/PR **#19 声称**国际版 refresh 是 `/v2/auth/token/refresh` —— 现网实测 `404 {"error_msg":"404 Route Not Found"}`，
//    且该 PR `merged=False`、从未进 shipped 代码。**别照抄未合并 PR 的说法**，一律以本文件路径为准。

/** 设备授权的平台参数；`workbuddy-ai` 与 `CLI` 两个值实测都能拿到 state+authUrl。 */
export const DEVICE_PLATFORM = envStr("MSLXDFF_GLOBALWORKBUDDY_PLATFORM", "workbuddy-ai");

// —— 客户端身份 ——
// 取证结论 B：`/v3/config` 的返回**不随 UA 变**（5 种配方字节级同一份目录：pool=30/cliRoster=26/usable=26），
// 所以这里用稳定值即可，不必像参考仓库那样去读安装 App 的 Info.plist。上游一旦收紧，用下面的 env 覆盖排障。
/** 本机注册表实测实装版本（`DisplayName=[WorkBuddy AI 5.6.2]`；国内版是 5.3.14）。
 *  ⚠ 2026-10-08 桌面端错误报告显示 App 已自升级至 **5.7.6** —— 但这不影响任何判定：
 *  官方客户端（自带正身 UA）与我们的请求收到**一字不差**的 11140，身份版本已被证明不是闸门的变量。 */
export const APP_VERSION = envStr("MSLXDFF_GLOBALWORKBUDDY_APP_VERSION", "5.6.2");
export const CHAT_UA = envStr("MSLXDFF_GLOBALWORKBUDDY_UA", `WorkBuddy/${APP_VERSION} WorkBuddy AI/${APP_VERSION} CLI/${APP_VERSION}`);
export const CATALOG_UA = envStr("MSLXDFF_GLOBALWORKBUDDY_CATALOG_UA", `WorkBuddyAI/${APP_VERSION}`);
export const REFRESH_UA = envStr("MSLXDFF_GLOBALWORKBUDDY_REFRESH_UA", CHAT_UA);

export const COOLDOWN_MS = Number(envStr("MSLXDFF_GLOBALWORKBUDDY_COOLDOWN_MS", "30000"));
export const CONNECT_TIMEOUT_MS = Number(envStr("MSLXDFF_GLOBALWORKBUDDY_TIMEOUT_MS", "30000"));
export const JSON_TIMEOUT_MS = 20_000;
export const CHAT_TIMEOUT_MS = 120_000;
export const MODELS_CACHE_MS = 10 * 60 * 1000;
export const BALANCE_CACHE_MS = 5 * 60 * 1000;
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** 11140（安全审核）实测会随机出现，同请求体原地重试可救回；次数上限走 env。 */
export const SAFETY_RETRY = Number(envStr("MSLXDFF_GLOBALWORKBUDDY_SAFETY_RETRY", "2"));

/** 兜底可调用模型（仅取数失败时展示用）。**刻意只写实测过的 id/倍率，不编造窗口数字。** */
export const KNOWN_MODELS = [
  { id: "hy3", credits: "x0.00" },
  { id: "hy4-preview-f", credits: "x0.00" },
  { id: "deepseek-v4.1-flash", credits: "x0.00" },
  { id: "glm-5.3-flash", credits: "x0.06" },
  { id: "gpt-6-luna", credits: "x0.07" },
];
/** 缺省模型：实测 x0.00 且响应快，做 hi 验收用。 */
export const FALLBACK_MODEL = "hy3";
