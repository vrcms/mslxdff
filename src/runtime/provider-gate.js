// 定制 provider 启用门禁（纯函数 + auth 号型名单），从 providers-setup.js 拆出以守住 ≤10KB 体积门。
// 背景：门禁曾要求 `baseUrl && keys` 两者皆有，导致 qoder（keys 有、baseUrl 空）被静默跳过 ——
// 表现为 /v1/models 无该供应商模型、`-models` 挑不到、网关报 `Model qoder/x is not supported`。
// Note: auth 号型不要求 baseUrl 是硬约束（旧门禁 baseUrl&&keys 曾静默跳过整家 qoder）— 见 .agents/notes/implemented/bug-fix/2026-09-21-auth-doc-provider-gate.md

/** 凭证在 auth 目录、无需 baseUrl 的「auth 号型」定制供应商（端点由各自 constants 决定）。 */
export const AUTH_DOC_PROVIDER_IDS = ["workbuddy", "traework", "qoder", "qwenwork", "globalqwenwork", "raccoon"];

/**
 * 免凭证供应商：上游就是 opencode zen 的免费层代理，没有 key 也能用（按出口 IP 计额度）。
 * 与 auth 号型不同：它连账号都不需要，只要在 state.providerConfigs 里有一条记录就启用。
 */
export const NO_CREDENTIAL_PROVIDER_IDS = ["railway"];

/**
 * - 免凭证型（railway）：有配置记录即启用（无需 keys/baseUrl）
 * - auth 号型：keys 或 auths 或 auth 目录有号 → 启用（baseUrl 可空）
 * - 其他定制（cline/codearts/插件注册）：有 keys → 启用（baseUrl 可空，端点由工厂决定）
 */
export function shouldEnableCustomProvider(gid, { keys = [], auths = [], hasAuthDocs = false } = {}) {
  if (NO_CREDENTIAL_PROVIDER_IDS.includes(gid)) return true;
  if (AUTH_DOC_PROVIDER_IDS.includes(gid)) return keys.length > 0 || auths.length > 0 || hasAuthDocs;
  return keys.length > 0;
}

/** 按 gid 载入各自 account-store 并列出落盘账号（失败/无目录 → 空数组，不抛）。 */
export async function loadAuthDocs(gid) {  try {
    const store = gid === "workbuddy"
      ? await import("../providers/workbuddy/account-store.js")
      : gid === "traework"
        ? await import("../providers/traework/account-store.js")
        : gid === "qwenwork"
          ? await import("../providers/qwenwork/account-store.js")
          : gid === "globalqwenwork"
            ? await import("../providers/globalqwenwork/account-store.js")
            : gid === "raccoon"
              ? await import("../providers/raccoon/account-store.js")
            : await import("../providers/qoder/account-store.js");
    return store.listAccountDocs();
  } catch {
    return [];
  }
}

/**
 * 免凭证供应商的配置种子：providers-setup 只遍历 state.providerConfigs 里已有的条目，
 * 没有记录就永远不会被装配。这里幂等补一条（已有则不动，保留用户改过的 baseUrl）。
 * 关闭：设 MSLXDFF_RAILWAY=0。
 *
 * saveConfig(gid, cfg) 由调用方注入，需自行处理两件事：
 *   ① 非空 baseUrl —— 否则 saveProviderConfig 见「无 url/key/白名单」会整条 delete；
 *   ② allowAnyModels —— 否则 /v1/models 按「空白名单=不暴露」的安全默认，一个模型都列不出。
 */
export async function seedNoCredentialProviders({ configs, saveConfig } = {}) {
  if (!configs || typeof saveConfig !== "function") return [];
  const seeded = [];
  for (const gid of NO_CREDENTIAL_PROVIDER_IDS) {
    if (configs[gid]) continue;                       // 已有配置：尊重用户设置
    if (gid === "railway") {
      if (isDisabled("MSLXDFF_RAILWAY")) continue;
      await saveConfig(gid, { baseUrl: RAILWAY_DEFAULT_BASE, keys: [], allowAnyModels: true });
      seeded.push(gid);
    }
  }
  return seeded;
}

const RAILWAY_DEFAULT_BASE = "https://mytestip-production.up.railway.app/ai-api";

function isDisabled(envName) {
  const raw = process.env[envName];
  if (raw === undefined || raw === null || raw === "") return false;
  const s = String(raw).trim().toLowerCase();
  return s === "0" || s === "false" || s === "off" || s === "no";
}
