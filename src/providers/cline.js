import { createKeyRing } from "./keyring.js";
import { loadProviderKeys, loadProviderBaseUrl, loadProviderModelsPath, loadProviderChatPath } from "../state.js";
import { envInt, joinUrl, getUndici, createAgent, collectApiKeysGeneric, createChatRunner, createPreheatRunner } from "./base.js";
import { joinModelId } from "./model-id.js";

const { UndiciFetch } = getUndici();

function resolveBaseUrl(id, baseUrl) {
  if (baseUrl) return String(baseUrl).trim().replace(/\/+$/, "");
  const env = loadProviderBaseUrl(id);
  if (env) return env;
  return "https://api.cline.bot";
}

function isClineBotHost(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return u.hostname === "api.cline.bot" || u.hostname.endsWith(".cline.bot");
  } catch { return String(baseUrl).includes("cline.bot"); }
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
  retry = {
    network: { attempts: 2, delayMs: 300 },
    429: { attempts: 1, delayMs: 100 },
    502: { attempts: 1, delayMs: 100 },
    503: { attempts: 1, delayMs: 100 },
    504: { attempts: 1, delayMs: 100 },
  },
  fetchImpl,
} = {}) {
  const resolvedBase = resolveBaseUrl(id, baseUrl);
  const resolvedModelsPath = modelsPath || loadProviderModelsPath(id) || "/ai/cline/recommended-models";
  // base 已含 /api/v1 时，chat 仅需 /chat/completions，否则会拼成 /api/v1/v1/...
  const defaultChat = String(resolvedBase).includes("/api/v1") ? "/chat/completions" : "/v1/chat/completions";
  const resolvedChatPath = chatPath || loadProviderChatPath(id) || defaultChat;
  if (!fetchImpl) fetchImpl = UndiciFetch || fetch;
  const ring = createKeyRing(collectApiKeysGeneric(id, apiKeys, apiKey, loadProviderKeys), { cooldownMs });

  let dispatcher = null;
  let agent = null;
  const a = createAgent({
    keepAliveTimeout: envInt("MSLXDFF_CLINE_KEEPALIVE_TIMEOUT", 30_000),
    keepAliveMaxTimeout: envInt("MSLXDFF_CLINE_KEEPALIVE_MAX_TIMEOUT", 60_000),
    connections: envInt("MSLXDFF_CLINE_KEEPALIVE_CONNECTIONS", 20),
  });
  agent = a.agent; dispatcher = a.dispatcher;

  function buildHeaders(body, key) {
    const isStream = body?.stream !== false;
    return {
      "Content-Type": "application/json",
      Accept: isStream ? "text/event-stream" : "*/*",
      "User-Agent": "mslxdff",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    };
  }

  const { runChat } = createChatRunner({
    id, ring, cooldownMs, retry, fetchImpl, dispatcher, buildHeaders,
    getUrl: () => joinUrl(resolvedBase, resolvedChatPath),
    connectTimeoutMs,
  });

  async function chat(body) { return runChat(body, ring, `MSLXDFF_${id.toUpperCase()}_KEY`); }
  async function chatWithKeys(body, keys) {
    const tmp = createKeyRing(keys, { cooldownMs });
    return runChat(body, tmp, "shared provider keys");
  }

  async function listModels() {
    const url = joinUrl(resolvedBase, resolvedModelsPath);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${id} models timed out`)), 15_000);
    try {
      const headers = { Accept: "application/json" };
      const key = ring.next();
      if (key) headers["Authorization"] = `Bearer ${key}`;
      const opts = { headers, signal: controller.signal };
      if (dispatcher) opts.dispatcher = dispatcher;
      const res = await fetchImpl(url, opts);
      if (!res.ok) return [];
      const json = await res.json().catch(() => ({}));
      // 定制：cline.bot 域名时，仅取 free 数组；其他回退通用
      if (isClineBotHost(resolvedBase) && Array.isArray(json.free)) {
        return json.free.filter((m) => m && typeof m.id === "string").map((m) => ({ ...m, id: joinModelId(id, m.id) }));
      }
      const raw = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : Array.isArray(json) ? json : [];
      return raw.filter((m) => m && typeof m.id === "string").map((m) => ({ ...m, id: joinModelId(id, m.id) }));
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  const { preheat } = createPreheatRunner({
    dispatcher, fetchImpl, getUrl: () => joinUrl(resolvedBase, resolvedModelsPath),
    id, ring, loadKeys: loadProviderKeys,
  });

  async function close() { if (agent?.close) try { await agent.close(); } catch {} }
  return { id, chat, chatWithKeys, listModels, preheat, close, agent, keyRing: ring, baseUrl: resolvedBase };
}
