import { createKeyRing } from "./keyring.js";
import { loadProviderKeys, loadProviderBaseUrl, loadProviderModelsPath, loadProviderChatPath } from "../state.js";
import { envInt, joinUrl, getUndici, createAgent, collectApiKeysGeneric, createChatRunner, createListModelsRunner, createPreheatRunner } from "./base.js";

const { UndiciFetch } = getUndici();

function resolveBaseUrl(id, baseUrl) {
  if (baseUrl) return String(baseUrl).trim().replace(/\/+$/, "");
  const env = loadProviderBaseUrl(id);
  if (env) return env;
  return "";
}

export function createGenericProvider({
  id,
  baseUrl,
  apiKeys,
  apiKey,
  modelsPath,
  chatPath,
  connectTimeoutMs = Number(process.env.MSLXDFF_GENERIC_TIMEOUT_MS) || 30_000,
  cooldownMs = envInt("MSLXDFF_GENERIC_COOLDOWN_MS", 30_000),
  retry = {
    network: { attempts: 2, delayMs: 300 },
    429: { attempts: 1, delayMs: 100 },
    502: { attempts: 1, delayMs: 100 },
    503: { attempts: 1, delayMs: 100 },
    504: { attempts: 1, delayMs: 100 },
  },
  fetchImpl,
  headers: extraHeaders,
  noAgent = false,
  file,
} = {}) {
  if (!id) throw new Error("generic provider requires id");
  const resolvedBase = resolveBaseUrl(id, baseUrl);
  if (!resolvedBase) throw new Error(`generic provider ${id}: missing baseUrl`);
  if (!fetchImpl) fetchImpl = UndiciFetch || fetch;
  const resolvedModelsPath = modelsPath || loadProviderModelsPath(id, file ? { file } : {});
  const resolvedChatPath = chatPath || loadProviderChatPath(id, file ? { file } : {});
  const ring = createKeyRing(collectApiKeysGeneric(id, apiKeys, apiKey, loadProviderKeys), { cooldownMs });

  let dispatcher = null;
  let agent = null;
  if (!noAgent) {
    const a = createAgent({
      keepAliveTimeout: envInt("MSLXDFF_GENERIC_KEEPALIVE_TIMEOUT", 30_000),
      keepAliveMaxTimeout: envInt("MSLXDFF_GENERIC_KEEPALIVE_MAX_TIMEOUT", 60_000),
      connections: envInt("MSLXDFF_GENERIC_KEEPALIVE_CONNECTIONS", 20),
    });
    agent = a.agent; dispatcher = a.dispatcher;
  }

  function buildHeaders(body, key) {
    const isStream = body?.stream !== false;
    const h = {
      "Content-Type": "application/json",
      Accept: isStream ? "text/event-stream" : "*/*",
      "User-Agent": "mslxdff",
    };
    if (key) h["Authorization"] = `Bearer ${key}`;
    return { ...h, ...extraHeaders };
  }

  const { runChat } = createChatRunner({
    id, ring, cooldownMs, retry, fetchImpl, dispatcher, buildHeaders,
    getUrl: () => joinUrl(resolvedBase, resolvedChatPath),
    connectTimeoutMs,
  });

  async function chat(body) {
    return runChat(body, ring, `MSLXDFF_${id.toUpperCase()}_KEY`);
  }
  async function chatWithKeys(body, keys) {
    const tmp = createKeyRing(keys, { cooldownMs });
    return runChat(body, tmp, "shared provider keys");
  }

  const { listModels } = createListModelsRunner({
    id, ring, dispatcher, fetchImpl,
    getUrl: () => joinUrl(resolvedBase, resolvedModelsPath),
  });

  const { preheat } = createPreheatRunner({
    dispatcher, fetchImpl, getUrl: () => joinUrl(resolvedBase, resolvedModelsPath),
    id, ring, loadKeys: loadProviderKeys,
  });

  async function close() {
    if (agent && typeof agent.close === "function") { try { await agent.close(); } catch {} }
  }

  return { id, chat, chatWithKeys, listModels, preheat, close, agent, keyRing: ring, baseUrl: resolvedBase };
}
