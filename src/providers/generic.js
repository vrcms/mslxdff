import { createKeyRing } from "./keyring.js";
import { loadProviderKeys, loadProviderBaseUrl, loadProviderModelsPath, loadProviderChatPath } from "../state.js";
import { envInt, joinUrl, getUndici, createAgent, collectApiKeysGeneric, createChatRunner, createListModelsRunner, createPreheatRunner } from "./base.js";
import { compatFetch } from "../compat.js";
import crypto from "node:crypto";
import { genId, opencodeUa, digestIdTail } from "../opencode-identity.js";

const { UndiciFetch } = getUndici();

function resolveBaseUrl(id, baseUrl) {
  if (baseUrl) return String(baseUrl).trim().replace(/\/+$/, "");
  const env = loadProviderBaseUrl(id);
  if (env) return env;
  return "";
}

function isOpencodeHost(baseUrl) {
  return /opencode\.ai/i.test(String(baseUrl || ""));
}

// Console Go (zen/go) 要求 x-opencode-session 才能路由（缺失 → 400 MissingSessionID）。
// 会话取值：已合规（ses_ 前缀）直接用；客户端透传的任意串做 sha1 摘要派生（稳定+合规）；
// 无则每请求 fresh（与 -chat curl / bench 直连行为一致）。
function resolveGoSession(sessionId) {
  const raw = String(sessionId || "").trim();
  if (/^ses_/.test(raw)) return raw;
  if (raw) {
    try {
      return `ses_${digestIdTail(crypto.createHash("sha1").update(raw).digest())}`;
    } catch {
      return genId("ses_");
    }
  }
  return genId("ses_");
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
  mapModel,
  noAgent = false,
  file,
} = {}) {
  if (!id) throw new Error("generic provider requires id");
  const resolvedBase = resolveBaseUrl(id, baseUrl);
  if (!resolvedBase) throw new Error(`generic provider ${id}: missing baseUrl`);
  if (!fetchImpl) fetchImpl = UndiciFetch || compatFetch;
  const resolvedModelsPath = modelsPath || loadProviderModelsPath(id, file ? { file } : {});
  const resolvedChatPath = chatPath || loadProviderChatPath(id, file ? { file } : {});
  const ring = createKeyRing(collectApiKeysGeneric(id, apiKeys, apiKey, loadProviderKeys), { cooldownMs });
  const goHost = isOpencodeHost(resolvedBase);

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

  function buildHeaders(body, key, opts) {
    const isStream = body?.stream !== false;
    const h = {
      "Content-Type": "application/json",
      Accept: isStream ? "text/event-stream" : "*/*",
      "User-Agent": "mslxdff",
    };
    if (key) h["Authorization"] = `Bearer ${key}`;
    const out = { ...h, ...extraHeaders };
    // ocgo（opencode.ai 域名）：补 Console Go 路由所需的 opencode 身份头
    if (goHost) {
      out["User-Agent"] = opencodeUa();
      out["x-opencode-client"] = "desktop";
      out["x-opencode-session"] = resolveGoSession(opts?.sessionId);
      out["x-opencode-request"] = genId("msg_");
      out["x-opencode-project"] = "global";
    }
    return out;
  }

  // base 的 attemptOnce 只调 buildHeaders(body, key)：用闭包把 opts.sessionId 带进去
  function scopedRunner(activeRing, opts) {
    return createChatRunner({
      id, ring: activeRing, cooldownMs, retry, fetchImpl, dispatcher,
      buildHeaders: (b, k) => buildHeaders(b, k, opts),
      getUrl: () => joinUrl(resolvedBase, resolvedChatPath),
      connectTimeoutMs,
    });
  }

  async function chat(body, opts) {
    const { runChat } = scopedRunner(ring, opts);
    return runChat(body, ring, `MSLXDFF_${id.toUpperCase()}_KEY`);
  }
  async function chatWithKeys(body, keys, opts) {
    const tmp = createKeyRing(keys, { cooldownMs });
    const { runChat } = scopedRunner(tmp, opts);
    return runChat(body, tmp, "shared provider keys");
  }

  const { listModels } = createListModelsRunner({
    id, ring, dispatcher, fetchImpl,
    getUrl: () => joinUrl(resolvedBase, resolvedModelsPath),
    mapModel,
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
