import { createKeyRing } from "../keyring.js";
import { loadProviderKeys, loadProviderAuths, loadProviderBaseUrl, WORKBUDDY_DEFAULT_BASE_URL, loadProviderModelsPath, loadProviderChatPath } from "../../state.js";
import { compatFetch } from "../../compat.js";
import { envInt, joinUrl, getUndici, createAgent } from "../base.js";
import { createAuthService, isAuthError, isInsufficientStatus, decodeJwtExp } from "./auth.js";
import { applyTokenRefresh, listAccountDocs } from "./account-store.js";
import { createChatService } from "./chat.js";
import { createModelsService } from "./models.js";
import { createBalanceCache, getCachedBalance as defaultGetCached, setCachedBalance as defaultSetCached } from "./balance.js";
import { defaultLogger } from "./rotation-log.js";

const { UndiciAgent, UndiciFetch } = getUndici();

function resolveBaseUrl(baseUrl) {
  if (baseUrl) return String(baseUrl).trim().replace(/\/+$/, "");
  const env = loadProviderBaseUrl("workbuddy");
  if (env) return env;
  return WORKBUDDY_DEFAULT_BASE_URL;
}

export function createWorkbuddyProvider({
  baseUrl,
  apiKeys,
  apiKey,
  auths,
  modelsPath,
  chatPath,
  connectTimeoutMs = Number(process.env.MSLXDFF_WORKBUDDY_TIMEOUT_MS) || 30_000,
  cooldownMs = envInt("MSLXDFF_WORKBUDDY_COOLDOWN_MS", 30_000),
  retry = {
    network: { attempts: 2, delayMs: 300 },
    429: { attempts: 1, delayMs: 100 },
    502: { attempts: 1, delayMs: 100 },
    503: { attempts: 1, delayMs: 100 },
    504: { attempts: 1, delayMs: 100 },
  },
  fetchImpl,
  file,
  balanceCache: balanceCacheOpt,
  logger: loggerOpt,
  clock = Date.now,
} = {}) {
  const id = "workbuddy";
  const resolvedBase = resolveBaseUrl(baseUrl);
  const resolvedModelsPath = modelsPath || loadProviderModelsPath(id, file ? { file } : {});
  const resolvedChatPath = chatPath || loadProviderChatPath(id, file ? { file } : {});
  if (!fetchImpl) fetchImpl = UndiciFetch || compatFetch;

  const keysFromState = loadProviderKeys(id, file ? { file } : {});
  const authsFromState = loadProviderAuths(id, file ? { file } : {});
  const keys = (() => {
    const list = [
      ...(Array.isArray(apiKeys) ? apiKeys : [apiKeys].filter(Boolean)),
      apiKey,
      ...(apiKeys === undefined && apiKey === undefined ? keysFromState : []),
    ].filter((k) => typeof k === "string" && k.trim().length);
    return [...new Set(list.map((k) => k.trim()))];
  })();
  let authList = Array.isArray(auths) && auths.length ? auths : authsFromState;

  if (!authList.length && !keys.length) {
    // 账号目录读取统一走 listAccountDocs：主位置（跟 state 走）优先，旧 cwd/auths 只读兜底
    try {
      for (const { uid, doc } of listAccountDocs()) {
        if (!keys.includes(doc.auth.accessToken)) keys.push(doc.auth.accessToken);
        authList.push({
          uid,
          domain: doc.auth.domain || "www.codebuddy.cn",
          enterpriseId: doc.account.enterpriseId || "",
          refreshToken: doc.auth.refreshToken || "",
        });
      }
    } catch {}
  }

  let ring = createKeyRing(keys, { cooldownMs, now: clock });

  const { agent, dispatcher } = createAgent({
    keepAliveTimeout: envInt("MSLXDFF_WORKBUDDY_KEEPALIVE_TIMEOUT", 30_000),
    keepAliveMaxTimeout: envInt("MSLXDFF_WORKBUDDY_KEEPALIVE_MAX_TIMEOUT", 60_000),
    connections: envInt("MSLXDFF_WORKBUDDY_KEEPALIVE_CONNECTIONS", 20),
  });

  const balanceCache = balanceCacheOpt || (() => {
    // adapt singleton default to interface expected by chat service
    return {
      getCachedBalance: defaultGetCached,
      setCachedBalance: defaultSetCached,
      getBalanceCache: () => null,
      clearBalanceCache: () => {},
    };
  })();

  const logger = loggerOpt || defaultLogger;

  const authService = createAuthService({
    baseUrl: resolvedBase,
    fetchImpl,
    clock,
    dispatcher,
    file,
    // 落盘细节单一源：account-store.applyTokenRefresh（数组就地更新 + state + auths 文件）
    saveFn: async ({ newAt, newRt, uid, oldKey, auth }) => {
      const r = await applyTokenRefresh({
        uid,
        oldKey,
        newToken: newAt,
        refreshToken: newRt,
        domain: auth?.domain || "www.codebuddy.cn",
        enterpriseId: auth?.enterpriseId || "",
        auth,
        keys,
        authList,
        file,
      });
      try { ring.replace(oldKey, newAt); } catch {}
      return r;
    },
  });

  const chatSvc = createChatService({
    id,
    baseUrl: resolvedBase,
    chatPath: resolvedChatPath,
    keys,
    authList,
    ring,
    fetchImpl,
    dispatcher,
    connectTimeoutMs,
    retry,
    balanceCache,
    authService,
    logger,
    clock,
    cooldownMs,
  });

  // models service needs closures for getKey/getAuth
  function getKey() { return ring.next() || keys[0] || ""; }
  function getAuth(k) {
    const idx = keys.indexOf(k);
    if (idx >= 0 && authList[idx]) return authList[idx];
    if (authList.length) return authList[0];
    return { uid: "", domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "" };
  }

  const modelsSvc = createModelsService({
    id,
    baseUrl: resolvedBase,
    modelsPath: resolvedModelsPath,
    fetchImpl,
    dispatcher,
    getKey,
    getAuth,
    maybeProactiveRefresh: authService.maybeProactiveRefresh,
    refreshTokenFor: authService.refreshTokenFor,
    isAuthError,
    clock,
  });

  async function chat(body, opts = {}) {
    const uid = opts?.workbuddyUid || body?._workbuddyUid;
    const cleanBody = uid ? (({ _workbuddyUid, ...rest }) => rest)(body) : body;
    return chatSvc.runChat(cleanBody, ring, uid ? { workbuddyUid: uid } : {});
  }

  async function chatWithKeys(body, keysOverride) {
    // 借入的 key（ADR-0019：转发时自动附带）——用隔离的 tmp ring/auth，不改动本机 ring。
    // Isolated tmp ring and auth without mutating shared arrays
    const tmpKeys = [...keysOverride].filter((k) => typeof k === "string" && k.trim().length).map((k) => k.trim());
    const tmpAuth = authList[0] || { uid: "", domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "" };
    const tmpAuthList = tmpKeys.map(() => tmpAuth);
    const tmpRing = createKeyRing(tmpKeys, { cooldownMs, now: clock });
    // create a temporary chat service that uses tmp state
    const tmpChatSvc = createChatService({
      id,
      baseUrl: resolvedBase,
      chatPath: resolvedChatPath,
      keys: tmpKeys,
      authList: tmpAuthList,
      ring: tmpRing,
      fetchImpl,
      dispatcher,
      connectTimeoutMs,
      retry,
      balanceCache,
      authService,
      logger,
      clock,
      cooldownMs,
    });
    return tmpChatSvc.runChat(body, tmpRing);
  }

  async function close() {
    if (agent && typeof agent.close === "function") {
      try { await agent.close(); } catch {}
    }
  }

  return {
    id,
    chat,
    chatWithKeys,
    listModels: modelsSvc.listModels,
    preheat: modelsSvc.preheat,
    close,
    agent,
    keyRing: ring,
    baseUrl: resolvedBase,
  };
}

// re-export submodules for tests that import directly
export { decodeJwtExp, isAuthError, isInsufficientStatus } from "./auth.js";
export { createBalanceCache } from "./balance.js";
