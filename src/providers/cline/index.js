import { createKeyRing } from "../keyring.js";
import { loadProviderKeys, loadProviderBaseUrl, loadProviderModelsPath, loadProviderChatPath, saveProviderConfig } from "../../state.js";
import { envInt, joinUrl, getUndici, createAgent, collectApiKeysGeneric, createChatRunner } from "../base.js";
import { joinModelId } from "../model-id.js";
import { createAuthPool } from "./auth.js";
import { clineHeaders, isRefreshToken } from "./headers.js";
import { createChatService } from "./chat.js";
import { createModelsService } from "./models.js";

const { UndiciFetch } = getUndici();

function resolveBaseUrl(id, baseUrl) {
  if (baseUrl) return String(baseUrl).trim().replace(/\/+$/, "");
  const env = loadProviderBaseUrl(id);
  if (env) return env;
  return "https://api.cline.bot";
}

export function createClineProvider({
  id = "cline",
  baseUrl,
  apiKeys,
  apiKey,
  modelsPath,
  chatPath,
  connectTimeoutMs = Number(process.env.MSLXDFF_CLINE_TIMEOUT_MS) || 30_000,
  cooldownMs = envInt("MSLXDFF_CLINE_COOLDOWN_MS", 30_000),
  retry = { network: { attempts: 2, delayMs: 300 }, 429: { attempts: 1, delayMs: 100 }, 502: { attempts: 1, delayMs: 100 }, 503: { attempts: 1, delayMs: 100 }, 504: { attempts: 1, delayMs: 100 } },
  fetchImpl,
  file,
} = {}) {
  const resolvedBase = resolveBaseUrl(id, baseUrl);
  const _cfgModels = modelsPath ? null : loadProviderModelsPath(id, file ? { file } : {});
  const resolvedModelsPath = modelsPath || (_cfgModels && _cfgModels !== "/models" ? _cfgModels : null) || "/ai/cline/recommended-models";
  const defaultChat = String(resolvedBase).includes("/api/v1") ? "/chat/completions" : "/api/v1/chat/completions";
  const resolvedChatPath = chatPath || loadProviderChatPath(id, file ? { file } : {}) || defaultChat;
  if (!fetchImpl) fetchImpl = UndiciFetch || fetch;

  const rawKeys = collectApiKeysGeneric(id, apiKeys, apiKey, (pid) => loadProviderKeys(pid, file ? { file } : {}));
  // 同时兼容 cline 与 clinebot 两个 id 的 keys（用户可能配在任一）
  let extraKeys = [];
  try {
    const altId = id === "cline" ? "clinebot" : "cline";
    const alt = loadProviderKeys(altId, file ? { file } : {});
    if (alt.length) extraKeys = alt;
  } catch {}
  const allKeys = [...new Set([...rawKeys, ...extraKeys].map((k) => String(k).trim()).filter(Boolean))];
  const hasRefresh = allKeys.some((k) => isRefreshToken(k, id));
  const ring = createKeyRing(allKeys.filter((k) => !isRefreshToken(k, id)), { cooldownMs });

  let dispatcher = null; let agent = null;
  const a = createAgent({ keepAliveTimeout: envInt("MSLXDFF_CLINE_KEEPALIVE_TIMEOUT", 30_000), keepAliveMaxTimeout: envInt("MSLXDFF_CLINE_KEEPALIVE_MAX_TIMEOUT", 60_000), connections: envInt("MSLXDFF_CLINE_KEEPALIVE_CONNECTIONS", 20) });
  agent = a.agent; dispatcher = a.dispatcher;

  // 旧直连模式（兼容 sk_ 匿名）
  function buildHeadersOld(body, key) {
    const isStream = body?.stream !== false;
    return { "Content-Type": "application/json", Accept: isStream ? "text/event-stream" : "*/*", "User-Agent": "mslxdff", ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  }
  const oldRunner = createChatRunner({ id, ring, cooldownMs, retry, fetchImpl, dispatcher, buildHeaders: buildHeadersOld, getUrl: () => joinUrl(resolvedBase, resolvedChatPath), connectTimeoutMs });

  // 新 refreshToken 模式
  let authPool = null; let newChatSvc = null;
  if (hasRefresh) {
    const refreshTokens = allKeys.filter((k) => isRefreshToken(k, id));
    authPool = createAuthPool({
      id, keys: refreshTokens, fetchImpl, dispatcher, baseUrl: resolvedBase, file,
      saveFn: async ({ oldRefreshToken, newRefreshToken }) => {
        try {
          const cur = loadProviderKeys(id, file ? { file } : {});
          const idx = cur.indexOf(oldRefreshToken);
          if (idx >= 0) {
            const next = [...cur]; next[idx] = newRefreshToken;
            // 优先写 providerConfigs，兼容旧路径由 saveProviderConfig 处理
            saveProviderConfig(id, { baseUrl: resolvedBase, keys: next }, file ? { file } : {});
          }
          // altId 同步
          const altId = id === "cline" ? "clinebot" : "cline";
          const cur2 = loadProviderKeys(altId, file ? { file } : {});
          const idx2 = cur2.indexOf(oldRefreshToken);
          if (idx2 >= 0) {
            const next2 = [...cur2]; next2[idx2] = newRefreshToken;
            saveProviderConfig(altId, { baseUrl: resolvedBase, keys: next2 }, file ? { file } : {});
          }
        } catch {}
      },
    });
    newChatSvc = createChatService({ id, baseUrl: resolvedBase, chatPath: resolvedChatPath, fetchImpl, dispatcher, authPool, connectTimeoutMs, retry });
  }

  async function chat(body) {
    if (hasRefresh && newChatSvc) return newChatSvc.runChat(body, ring, id);
    return oldRunner.runChat(body, ring, `MSLXDFF_${id.toUpperCase()}_KEY`);
  }

  async function chatWithKeys(body, keys) {
    const refreshSubset = (keys || []).filter((k) => isRefreshToken(k, id));
    if (refreshSubset.length && hasRefresh) {
      const tmpPool = createAuthPool({ id, keys: refreshSubset, fetchImpl, dispatcher, baseUrl: resolvedBase, file });
      const tmpSvc = createChatService({ id, baseUrl: resolvedBase, chatPath: resolvedChatPath, fetchImpl, dispatcher, authPool: tmpPool, connectTimeoutMs, retry });
      return tmpSvc.runChat(body, createKeyRing([], { cooldownMs }), "shared");
    }
    const tmpRing = createKeyRing((keys || []).filter((k) => !isRefreshToken(k, id)), { cooldownMs });
    return oldRunner.runChat(body, tmpRing, "shared provider keys");
  }

  const modelsSvc = createModelsService({ id, baseUrl: resolvedBase, modelsPath: resolvedModelsPath, fetchImpl, dispatcher, ring, loadKeys: (pid) => loadProviderKeys(pid, file ? { file } : {}) });

  async function listModels() {
    const list = await modelsSvc.listModels();
    // 若新模式且上游返回 free，再尝试带 token 的 models（兼容私有）
    return list;
  }

  const { preheat } = (() => {
    try { return modelsSvc; } catch { return { preheat: async () => ({ ok: false }) }; }
  })();

  async function close() { if (agent?.close) try { await agent.close(); } catch {} }
  return { id, chat, chatWithKeys, listModels, preheat, close, agent, keyRing: ring, baseUrl: resolvedBase, _authPool: authPool };
}
