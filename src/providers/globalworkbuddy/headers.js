// 三条通道的请求头装配。与国内版（`workbuddy/chat.js:12` 的 buildAuthHeaders）有三处**有意的**不同，
// 全部来自 2026-10-05 取证与参考仓库 upstream.ts:374-421 的通道隔离纪律：
//  ① Origin/Referer 与 host 同源 —— 国内版对 `.ai` token 发 `www.codebuddy.cn` 的 Origin 属跨产品指纹错配；
//  ② chat 通道**绝不**携带 refreshToken（参考仓库注释称「安全红线」，我们国内版没这条约束但同样该守）；
//  ③ refresh 通道**不带** `Authorization: Bearer`（`global-hi.js:143` 现在带着可能已过期的 token，属错误做法）。
// 缺值一律走 `X-No-*` 占位：上游区分「字段缺失」与「字段为空」（参考仓库同款处理）。

import {
  ORIGIN, DOMAIN, CHAT_UA, CATALOG_UA, REFRESH_UA, APP_VERSION,
} from "./constants.js";

function common(ua) {
  return {
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: ORIGIN,
    Referer: `${ORIGIN}/`,
    "User-Agent": ua,
  };
}

/** 身份类头：uid/enterpriseId/domain 缺值走 X-No-* 占位。 */
function identityHeaders(cred) {
  const uid = String(cred?.uid || "");
  const ent = String(cred?.enterpriseId || "");
  const domain = String(cred?.domain || "") || DOMAIN;
  return {
    ...(uid ? { "X-User-Id": uid } : { "X-No-User-Id": "1" }),
    ...(ent ? { "X-Enterprise-Id": ent, "X-Tenant-Id": ent } : { "X-No-Enterprise-Id": "1" }),
    ...(cred?.domain ? { "X-Domain": domain } : { "X-No-Department-Info": "1" }),
  };
}

/** chat：只带 Bearer，永不含 refreshToken。Accept 用「全量族」写法（实测穿得过参数校验）。 */
export function chatHeaders(cred) {
  return {
    ...common(CHAT_UA),
    "Content-Type": "application/json",
    "Accept-Language": "en-US",
    "X-IDE-Name": "WorkBuddy",
    "X-IDE-Type": "WorkBuddy",
    "X-IDE-Version": APP_VERSION,
    "X-Product": "SaaS",
    ...identityHeaders(cred),
    Authorization: `Bearer ${cred?.accessToken || ""}`,
  };
}

/** 目录（/v3/config）：Bearer + 同源 Origin；UA 独立可覆盖（结论 B 证明上游不据此分流，但留排障口子）。 */
export function catalogHeaders(cred) {
  return {
    Accept: "application/json",
    Origin: ORIGIN,
    Referer: `${ORIGIN}/`,
    "X-Requested-With": "XMLHttpRequest",
    "X-Product": "SaaS",
    "User-Agent": CATALOG_UA,
    Authorization: `Bearer ${cred?.accessToken || ""}`,
  };
}

/** refresh：`X-Refresh-Token` 只出现在这里；**不带 Authorization**。 */
export function refreshHeaders(cred) {
  return {
    ...common(REFRESH_UA),
    "Content-Type": "application/json",
    "X-Refresh-Token": String(cred?.refreshToken || ""),
    "X-Auth-Refresh-Source": "workbuddy",
    ...identityHeaders(cred),
  };
}

/** 计费（余额）：Bearer + 身份头，无 IDE 指纹。 */
export function billingHeaders(cred) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Origin: ORIGIN,
    Referer: `${ORIGIN}/`,
    "User-Agent": CHAT_UA,
    ...identityHeaders(cred),
    Authorization: `Bearer ${cred?.accessToken || ""}`,
  };
}

/** 设备授权流（登录时手里还没有凭据）：UA/Origin 齐，但既无 Bearer 也无 X-User-Id。 */
export function deviceHeaders() {
  return { ...common(REFRESH_UA), "Content-Type": "application/json" };
}
