// 定制 provider 启用门禁（纯函数 + auth 号型名单），从 providers-setup.js 拆出以守住 ≤10KB 体积门。
// 背景：门禁曾要求 `baseUrl && keys` 两者皆有，导致 qoder（keys 有、baseUrl 空）被静默跳过 ——
// 表现为 /v1/models 无该供应商模型、`-models` 挑不到、网关报 `Model qoder/x is not supported`。
// Note: auth 号型不要求 baseUrl 是硬约束（旧门禁 baseUrl&&keys 曾静默跳过整家 qoder）— 见 .agents/notes/implemented/bug-fix/2026-09-21-auth-doc-provider-gate.md

/** 凭证在 auth 目录、无需 baseUrl 的「auth 号型」定制供应商（端点由各自 constants 决定）。 */
export const AUTH_DOC_PROVIDER_IDS = ["workbuddy", "traework", "qoder"];

/**
 * - auth 号型：keys 或 auths 或 auth 目录有号 → 启用（baseUrl 可空）
 * - 其他定制（cline/codearts/插件注册）：有 keys → 启用（baseUrl 可空，端点由工厂决定）
 */
export function shouldEnableCustomProvider(gid, { keys = [], auths = [], hasAuthDocs = false } = {}) {
  if (AUTH_DOC_PROVIDER_IDS.includes(gid)) return keys.length > 0 || auths.length > 0 || hasAuthDocs;
  return keys.length > 0;
}

/** 按 gid 载入各自 account-store 并列出落盘账号（失败/无目录 → 空数组，不抛）。 */
export async function loadAuthDocs(gid) {
  try {
    const store = gid === "workbuddy"
      ? await import("../providers/workbuddy/account-store.js")
      : gid === "traework"
        ? await import("../providers/traework/account-store.js")
        : await import("../providers/qoder/account-store.js");
    return store.listAccountDocs();
  } catch {
    return [];
  }
}
