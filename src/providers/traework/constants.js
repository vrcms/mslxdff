// traework SOLO 上游技术常量（照抄 traework2api internal/upstream/constants.go，禁止改值）。
export const AGENT_HOST = "https://trae-api-cn.mchost.guru";
export const UG_HOST = "https://api.trae.cn";
export const OAUTH_HOST = "https://api.trae.com.cn";
export const CONSOLE_HOST = "https://www.trae.cn";
export const CLIENT_ID = "en1oxy7wnw8j9n";
export const APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
export const IDE_VERSION = "0.1.43";
export const IDE_VERSION_CODE = "20260716";
export const DEVICE_BRAND = "83DG";
export const OS_VERSION = "Windows 11 Pro";
export const FUNCTION = "solo_work_lite";
export const TRAE_UA = "Trae/0.1.43";
export const DEFAULT_MODEL = "glm-5.2";
export const EP_CHAT = "/api/agent/v3/llm_utils_chat";
export const EP_MODELS = "/api/ide/v1/get_detail_param";
export const EP_EXCHANGE = "/cloudide/api/v3/trae/oauth/ExchangeToken";
export const EP_USER_INFO = "/cloudide/api/v3/trae/GetUserInfo";
export const EP_CHECKIN_STATUS = "/trae/api/v2/ug/checkin_credits/status";
export const EP_CHECKIN_CLAIM = "/trae/api/v2/ug/checkin_credits/claim";
export const EP_ENT_USAGE = "/trae/api/v2/pay/ide_user_ent_usage";

// ── 市场/UG 侧线上契约（status/claim/ent_usage 共用）────────────────────────
// 出处：抓包复刻自 NextAgentX/trae-workbuddy-switch `modules/trae/credits.rs:49-99`，
// 不是从客户端源码抄的 —— 该仓自述「把 `x-market-client-id`/`x-market-user-id`/`x-lscbd-aid`
// 与整串 `VSCode 1.107.1 (TRAE SOLO CN)` 在 Trae 安装目录 5141 个文件（含 .exe/.asar）里全扫一遍，
// **一个字面量都搜不到**」，即无法从客户端侧核对，只能以「线上实测能用」为准。
// ⚠ 因此这些值是**线上契约**，不要"顺手改成看起来更对的"；要改必须先拿到抓包证据。
// 上面那段纪律原文见该仓 credits.rs:53-76。
export const MARKET_UA_PRODUCT = "TRAE SOLO CN";      // UA 括号里的产品名
export const MARKET_VSCODE_VERSION = "1.107.1";       // 真机 resources/app/package.json 的 version
export const MARKET_UA = `VSCode ${MARKET_VSCODE_VERSION} (${MARKET_UA_PRODUCT})`;
export const MARKET_AID = "787976";                   // x-lscbd-aid（活动/埋点侧应用标识）
export const MARKET_SDK_TYPE = "3";                   // x-lgw-req-sdk-type
export const MARKET_PACKAGE_TYPE = "stable_cn";       // package-type，CN 稳定版通道
export const MARKET_USER_REGION = "CN";               // x-user-region，产品级 CN 通道，不随账号 Region 变
export const MARKET_APP_VERSION = "0.1.45";           // app-version（≠ 上面的 IDE_VERSION 0.1.43：两条通道各自取值，别合）

// 市场伪设备身份的派生算法版本（抄 device.rs:35 DEVICE_GEN）。
// auth 文档里的 `market.gen` 缺失或小于此值 → 视为旧算法产物，就地重建（自愈）。
export const MARKET_DEVICE_GEN = 2;
