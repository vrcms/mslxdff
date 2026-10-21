// AgentRouter 定制供应商：OpenAI 兼容聚合网关，有三道硬门槛（2026-10-21 现网 curl 实测）：
//   ① 客户端身份白名单 —— UA 为 `mslxdff`/`curl`/浏览器一律 401 `unauthorized client detected`，
//      只放行 `opencode/*` 与 `claude-cli/<ver> (external…)`；
//   ② 模型分端点 —— `deepseek-v4-flash` 吃 /v1/chat/completions，`gpt-6.1-sol`/`gpt-6-astra`
//      对该端点回 400「请改用 /v1/responses」，只在 responses 通道可用；
//   ③ 内容闸 —— 正文含 `x-anthropic` 字样稳定 500 `sensitive words detected`（连 user 消息也拦，
//      与 workbuddy 只扫 system/assistant 不同），见 stripAgentRouterSensitive。
// 故不复用 generic（其 UA 写死 `mslxdff`、responses 判定只认 models.dev npm 索引），这里自组装，
// 底层仍复用 base.js 的 runner 与 responses-channel 的协议互转。
import { createKeyRing } from "./keyring.js";
import { loadProviderBaseUrl, loadProviderKeys } from "../state.js";
import { createChatRunner, createAgent, envInt, getUndici, joinUrl, collectApiKeysGeneric } from "./base.js";
import { createResponsesChannel, resolveResponsesPath } from "./responses-channel.js";
import { compatFetch } from "../compat.js";
import { opencodeUa } from "../opencode-identity.js";
import { joinModelId } from "./model-id.js";

const { UndiciFetch } = getUndici();

export const DEFAULT_AGENTROUTER_BASE = "https://agentrouter.org";
export const MODELS_PATH = "/v1/models";
export const CHAT_PATH = "/v1/chat/completions";
export const RESPONSES_PATH = "/v1/responses";

// 只吃 responses 的模型族：现网实测 gpt-6* 打 chat 端点回 400 并显式要求改 /v1/responses。
const RESPONSES_PREFIXES = ["gpt-6"];

export function isAgentRouterResponsesModel(model) {
  const m = String(model || "").trim().toLowerCase();
  if (!m) return false;
  return RESPONSES_PREFIXES.some((p) => m.startsWith(p));
}

// baseUrl 归一：缺省取 state/env，剥掉尾部 `/v1`（路径常量自带 `/v1`，避免 /v1/v1）
export function resolveAgentRouterBase(baseUrl) {
  const raw = baseUrl || loadProviderBaseUrl("agentrouter") || DEFAULT_AGENTROUTER_BASE;
  return String(raw).trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

// responses 通道内部两处 stream 判据不一致（响应通道用 `!== false` 决定读法，body 转换用
// `=== true` 决定发什么）：客户端不显式给 stream 时，会去把未转换的上游 JSON 当 chat 形状读。
// 这里先把意图钉成布尔，两条路径就同源了。
export function normalizeResponsesBody(body) {
  if (!body || typeof body !== "object") return body;
  return { ...body, stream: body.stream === true };
}

// AgentRouter 内容闸：稳定拦截正文里含 `x-anthropic` 字样的请求（2026-10-21 现网实测：
// `500 sensitive words detected` / `400 content-blocked`，连 `x-anthropic` 一个词也拦；
// `x-google`/`x-meta`/`x-openai`/`anthropic` 均放行——这是对 Anthropic 内部计费头/代理指纹的反代理风控）。
// 与 workbuddy 的 CC_SENTENCES 剥离同类，但**必须覆盖所有 role**（workbuddy 只扫 system/assistant，
// 而 agentrouter 连 user/tool 消息里出现该串也拦）。用零宽空格断开子串匹配、不动其余内容。
// 返回新对象（messages 浅拷贝），不污染调用方 body（dispatcher 可能复用同一 body 做兜底重试）。
const AR_SENSITIVE = /x-anthropic/gi;

export function stripAgentRouterSensitive(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (!Array.isArray(obj.messages)) return obj;
  const mask = (text) => (typeof text === "string" && AR_SENSITIVE.test(text) ? text.replace(AR_SENSITIVE, "x​anthropic") : text);
  const out = { ...obj, messages: obj.messages.map((m) => {
    if (!m || typeof m !== "object") return m;
    const nm = { ...m };
    if (typeof m.content === "string") nm.content = mask(m.content);
    else if (Array.isArray(m.content)) nm.content = m.content.map((p) => (p && typeof p === "object" && typeof p.text === "string" ? { ...p, text: mask(p.text) } : p));
    if (typeof m.name === "string") nm.name = mask(m.name);
    return nm;
  }) };
  return out;
}

export function createAgentRouterProvider({
  id = "agentrouter",
  baseUrl,
  apiKeys,
  apiKey,
  connectTimeoutMs = envInt("MSLXDFF_AGENTROUTER_TIMEOUT_MS", 60_000),
  cooldownMs = envInt("MSLXDFF_AGENTROUTER_COOLDOWN_MS", 30_000),
  fetchImpl,
  file,
} = {}) {
  if (id !== "agentrouter") throw new Error(`agentrouter provider id mismatch: ${id}`);
  const resolvedBase = resolveAgentRouterBase(baseUrl);
  if (!fetchImpl) fetchImpl = UndiciFetch || compatFetch;

  const ring = createKeyRing(
    collectApiKeysGeneric(id, apiKeys, apiKey, (pid) => loadProviderKeys(pid, file ? { file } : {})),
    { cooldownMs },
  );

  let agent = null; let dispatcher = null;
  {
    const a = createAgent({
      keepAliveTimeout: envInt("MSLXDFF_AGENTROUTER_KEEPALIVE_TIMEOUT", 30_000),
      keepAliveMaxTimeout: envInt("MSLXDFF_AGENTROUTER_KEEPALIVE_MAX_TIMEOUT", 60_000),
      connections: envInt("MSLXDFF_AGENTROUTER_KEEPALIVE_CONNECTIONS", 20),
    });
    agent = a.agent; dispatcher = a.dispatcher;
  }

  // 身份 UA：白名单只认 opencode / claude-cli，缺了恒 401。单独 env 可覆盖，不联动全局。
  function identityUa() {
    return process.env.MSLXDFF_AGENTROUTER_UA || opencodeUa();
  }

  function buildHeaders(body, key) {
    const isStream = body?.stream !== false;
    const h = {
      "Content-Type": "application/json",
      Accept: isStream ? "text/event-stream" : "*/*",
      "User-Agent": identityUa(),
    };
    if (key) h.Authorization = `Bearer ${key}`;
    return h;
  }

  function jsonHeaders(key) {
    const h = { Accept: "application/json", "User-Agent": identityUa() };
    if (key) h.Authorization = `Bearer ${key}`;
    return h;
  }

  const { runChat } = createChatRunner({
    id, ring, cooldownMs, fetchImpl, dispatcher, buildHeaders,
    getUrl: () => joinUrl(resolvedBase, CHAT_PATH),
    connectTimeoutMs,
    // 非流式走原生（SDK 通道只服务 opencode zen 的形状），responses 另走专用通道
    sdkDispatch: { enabled: false },
  });

  const responses = createResponsesChannel({
    id,
    url: joinUrl(resolvedBase, resolveResponsesPath(id, RESPONSES_PATH)),
    connectTimeoutMs,
    cooldownMs,
    // 关 SDK：其缺省会强塞 include:["reasoning.encrypted_content"] / store:false，agentrouter 未验证支持
    sdkEnabled: false,
    buildHeaders,
    fetchImpl,
    dispatcher,
  });

  async function chat(body, opts) {
    const sourceKey = `MSLXDFF_AGENTROUTER_KEY`;
    const clean = stripAgentRouterSensitive(body);
    if (isAgentRouterResponsesModel(clean?.model)) return responses.run(normalizeResponsesBody(clean), ring, sourceKey, opts);
    return runChat(clean, ring, sourceKey);
  }

  async function chatWithKeys(body, keys, opts) {
    const tmp = createKeyRing(keys, { cooldownMs });
    const clean = stripAgentRouterSensitive(body);
    if (isAgentRouterResponsesModel(clean?.model)) return responses.run(normalizeResponsesBody(clean), tmp, "shared provider keys", opts);
    const scoped = createChatRunner({
      id, ring: tmp, cooldownMs, fetchImpl, dispatcher, buildHeaders,
      getUrl: () => joinUrl(resolvedBase, CHAT_PATH),
      connectTimeoutMs,
      sdkDispatch: { enabled: false },
    });
    return scoped.runChat(clean, tmp, "shared provider keys");
  }

  let modelsCache = { at: 0, list: [] };
  const MODELS_TTL_MS = 10 * 60 * 1000;

  async function fetchModels() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${id} models timed out`)), 15_000);
    try {
      const key = ring.next() || ring.keys[0];
      const opts = { headers: jsonHeaders(key), signal: controller.signal };
      if (dispatcher) opts.dispatcher = dispatcher;
      const res = await fetchImpl(joinUrl(resolvedBase, MODELS_PATH), opts);
      if (!res.ok) throw new Error(`${id} models: http ${res.status}`);
      const json = await res.json().catch(() => ({}));
      return Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
    } finally {
      clearTimeout(timer);
    }
  }

  async function listModels() {
    if (modelsCache.list.length && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.list;
    let raw = [];
    try {
      raw = await fetchModels();
    } catch {
      return modelsCache.list; // 拉取失败给上次缓存（首次为空），不阻断启动
    }
    const list = raw
      .filter((m) => m && typeof m.id === "string" && m.id.trim())
      .map((m) => ({
        id: joinModelId(id, m.id),
        object: "model",
        name: m.name || m.id,
        owned_by: m.owned_by || "agentrouter",
        ...(m.created ? { created: m.created } : {}),
      }));
    modelsCache = { at: Date.now(), list };
    return list;
  }

  async function preheat() {
    try {
      const m = await listModels();
      return { ok: m.length > 0, models: m.length };
    } catch (err) {
      return { ok: false, error: String(err?.message || err).slice(0, 120) };
    }
  }

  async function close() { if (agent?.close) try { await agent.close(); } catch {} }

  return {
    id,
    chat,
    chatWithKeys,
    listModels,
    preheat,
    close,
    agent,
    keyRing: ring,
    baseUrl: resolvedBase,
    responsesUrl: responses.url,
  };
}
