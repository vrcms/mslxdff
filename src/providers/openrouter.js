import { createKeyRing } from "./keyring.js";
import { loadProviderKeys } from "../state.js";
import { envInt, joinUrl, getUndici, createAgent, createChatRunner, createListModelsRunner, createPreheatRunner } from "./base.js";
import { joinModelId } from "./model-id.js";

const { UndiciFetch } = getUndici();
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

function collectApiKeys(apiKeys, apiKey) {
  const list = [
    ...(Array.isArray(apiKeys) ? apiKeys : [apiKeys].filter(Boolean)),
    apiKey,
    ...(apiKeys === undefined && apiKey === undefined ? loadProviderKeys("openrouter") : []),
  ].filter((k) => typeof k === "string" && k.trim().length);
  return [...new Set(list.map((k) => k.trim()))];
}

export function createOpenRouterProvider({
  apiKeys,
  apiKey,
  baseUrl = process.env.MSLXDFF_OPENROUTER_BASE_URL || DEFAULT_BASE_URL,
  connectTimeoutMs = Number(process.env.MSLXDFF_OPENROUTER_TIMEOUT_MS) || 30_000,
  cooldownMs = envInt("MSLXDFF_OPENROUTER_COOLDOWN_MS", 30_000),
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
} = {}) {
  if (!fetchImpl) fetchImpl = UndiciFetch || fetch;
  const ring = createKeyRing(collectApiKeys(apiKeys, apiKey), { cooldownMs });
  let dispatcher = null; let agent = null;
  if (!noAgent) {
    const a = createAgent({
      keepAliveTimeout: envInt("MSLXDFF_OA_KEEPALIVE_TIMEOUT", 30_000),
      keepAliveMaxTimeout: envInt("MSLXDFF_OA_KEEPALIVE_MAX_TIMEOUT", 60_000),
      connections: envInt("MSLXDFF_OA_KEEPALIVE_CONNECTIONS", 20),
    });
    agent = a.agent; dispatcher = a.dispatcher;
  }

  function buildHeaders(body, key) {
    const isStream = body?.stream !== false;
    const h = {
      "Content-Type": "application/json",
      Accept: isStream ? "text/event-stream" : "*/*",
      "User-Agent": "mslxdff",
      "HTTP-Referer": process.env.MSLXDFF_OPENROUTER_REFERER || "https://github.com/mslxdff",
      "X-Title": process.env.MSLXDFF_OPENROUTER_TITLE || "mslxdff",
    };
    if (key) h["Authorization"] = `Bearer ${key}`;
    return { ...h, ...extraHeaders };
  }

  const { runChat } = createChatRunner({
    id: "openrouter", ring, cooldownMs, retry, fetchImpl, dispatcher, buildHeaders,
    getUrl: () => `${baseUrl}/chat/completions`,
    connectTimeoutMs,
  });

  async function chat(body) { return runChat(body, ring, "MSLXDFF_OPENROUTER_KEY"); }
  async function chatWithKeys(body, keys) {
    const tmp = createKeyRing(keys, { cooldownMs });
    return runChat(body, tmp, "shared provider keys");
  }

  const { listModels } = createListModelsRunner({
    id: "openrouter", ring, dispatcher, fetchImpl,
    getUrl: () => `${baseUrl}/models`,
    // openrouter 仅暴露免费模型
    mapModel: (raw) => raw.filter((m) => Number(m.pricing?.prompt || 0) === 0 && Number(m.pricing?.completion || 0) === 0),
  });

  const { preheat } = createPreheatRunner({
    dispatcher, fetchImpl, getUrl: () => `${baseUrl}/models`,
    id: "openrouter", ring,
  });

  async function close() { if (agent?.close) { try { await agent.close(); } catch {} } }

  return { id: "openrouter", chat, chatWithKeys, listModels, preheat, close, agent, keyRing: ring };
}
