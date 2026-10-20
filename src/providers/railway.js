// Railway 定制供应商：opencode zen free 层的**另一个 IP 出口**（Railway 边缘反代 opencode.ai）。
// 本质：同一套 zen 契约，只是出口 IP 不同 ⇒ 免费额度按出口 IP 计，等于多一份额度。
//
// 与内置 opencode 的区别：
//   ① 只暴露 free 模型（上游 /models 会把付费模型一起列出来，这里过滤掉）；
//   ② 每个请求强制补 free-lane 形状（stream:true + 五个核心工具名），否则 403 FreeTierError；
//   ③ 带 opencode 身份头（UA + client/session/request/project），否则同样 403。
//
// 端点：<base>/zen/v1/models、<base>/zen/v1/chat/completions（base 缺省为 Railway 反代根）。
import { createKeyRing } from "./keyring.js";
import { collectApiKeysGeneric, envInt, createAgent, getUndici, joinUrl } from "./base.js";
import { compatFetch } from "../compat.js";
import { loadProviderBaseUrl, loadProviderKeys, saveProviderConfig } from "../state.js";
import { ensureFreeLaneShape, aggregateChatSse } from "../free-lane.js";
import { genId, opencodeUa } from "../opencode-identity.js";
import { joinModelId } from "./model-id.js";

const { UndiciFetch } = getUndici();

export const DEFAULT_RAILWAY_BASE = "https://mytestip-production.up.railway.app/ai-api";
export const MODELS_PATH = "/zen/v1/models";
export const CHAT_PATH = "/zen/v1/chat/completions";

// free 模型判定：上游用 `-free` 后缀标识免费档（如 deepseek-v4.1-flash-free）。
// `big-pickle`/`beam` 这类无后缀但确属免费档的也列出（它们是 zen 的免费模型且不能被付费调用）。
const FREE_SUFFIX = /-free$/i;
const FREE_EXTRA = new Set(["big-pickle", "beam"]);

export function isFreeModelId(id) {
  const s = String(id || "").trim();
  if (!s) return false;
  return FREE_SUFFIX.test(s) || FREE_EXTRA.has(s.toLowerCase());
}

export function filterFreeModels(list) {
  return (Array.isArray(list) ? list : []).filter((m) => m && isFreeModelId(m.id));
}

function resolveBase(baseUrl) {
  if (baseUrl) return String(baseUrl).trim().replace(/\/+$/, "");
  const env = loadProviderBaseUrl("railway");
  return env || DEFAULT_RAILWAY_BASE;
}

export function createRailwayProvider({
  id = "railway",
  baseUrl,
  apiKeys,
  apiKey,
  connectTimeoutMs = envInt("MSLXDFF_RAILWAY_TIMEOUT_MS", 60_000),
  cooldownMs = envInt("MSLXDFF_RAILWAY_COOLDOWN_MS", 30_000),
  fetchImpl,
  file,
  clock = Date.now,
} = {}) {
  if (id !== "railway") throw new Error(`railway provider id mismatch: ${id}`);
  const resolvedBase = resolveBase(baseUrl);
  if (!fetchImpl) fetchImpl = UndiciFetch || compatFetch;

  const rawKeys = collectApiKeysGeneric(id, apiKeys, apiKey, (pid) => loadProviderKeys(pid, file ? { file } : {}));
  const allKeys = [...new Set(rawKeys.map((k) => String(k).trim()).filter(Boolean))];
  const ring = createKeyRing(allKeys, { cooldownMs });

  let agent = null; let dispatcher = null;
  try {
    const a = createAgent({
      keepAliveTimeout: envInt("MSLXDFF_RAILWAY_KEEPALIVE_TIMEOUT", 30_000),
      keepAliveMaxTimeout: envInt("MSLXDFF_RAILWAY_KEEPALIVE_MAX_TIMEOUT", 60_000),
      connections: envInt("MSLXDFF_RAILWAY_KEEPALIVE_CONNECTIONS", 20),
    });
    agent = a.agent; dispatcher = a.dispatcher;
  } catch {}

  // 身份头 + free-lane：railway 反代的是 zen，两样缺一不可（缺任一都是 403 FreeTierError）。
  function buildHeaders(opts = {}) {
    return {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "User-Agent": opencodeUa(),
      "x-opencode-client": "desktop",
      // session 复用调用方给的会话 id（同会话粘同一上游会话），没有才现生成
      "x-opencode-session": opts.sessionId ? `ses_${String(opts.sessionId).slice(0, 24)}` : genId("ses_"),
      "x-opencode-request": genId("msg_"),
      "x-opencode-project": "global",
      ...(ring.size ? {} : {}),
    };
  }

  async function chat(body, opts = {}) {
    const wantStream = body?.stream === true;
    // free-lane 强制 stream:true：非流式请求在这里补形状，聚合回 JSON 后再返回。
    const outBody = { ...body, stream: true };
    ensureFreeLaneShape(outBody);
    const headers = buildHeaders(opts);
    const key = ring.size ? ring.next() : null;
    if (key) headers.Authorization = `Bearer ${key}`;

    const url = joinUrl(resolvedBase, CHAT_PATH);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`railway timed out after ${connectTimeoutMs}ms`)), connectTimeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(outBody),
        signal: ac.signal,
        ...(dispatcher ? { dispatcher } : {}),
      });
    } catch (err) {
      clearTimeout(timer);
      if (key) ring.onError(key);
      throw err;
    }
    clearTimeout(timer);

    if (res.status >= 400) {
      if (key) ring.onError(key);
      return res;
    }
    if (!wantStream) {
      // 客户端要非流式：把上游 SSE 聚合回 chat.completion JSON
      return aggregateChatSse(res);
    }
    return res;
  }

  let modelsCache = { at: 0, list: [] };
  const MODELS_TTL_MS = 10 * 60 * 1000;

  async function fetchModels() {
    const key = ring.size ? ring.next() : null;
    const headers = { "Accept": "application/json", "User-Agent": opencodeUa() };
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await fetchImpl(joinUrl(resolvedBase, MODELS_PATH), {
      headers,
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (!res.ok) throw new Error(`railway models: http ${res.status}`);
    const j = await res.json();
    return filterFreeModels(j?.data);
  }

  async function listModels() {
    if (clock() - modelsCache.at < MODELS_TTL_MS && modelsCache.list.length) return modelsCache.list;
    let raw = [];
    try {
      raw = await fetchModels();
    } catch {
      return modelsCache.list; // 拉取失败：给上一次的缓存（首次则空表），不阻断启动
    }
    const list = raw.map((m) => ({
      id: joinModelId(id, m.id),
      object: "model",
      name: m.name || m.id,
      owned_by: m.owned_by || "opencode",
      ...(m.created ? { created: m.created } : {}),
    }));
    modelsCache = { at: clock(), list };
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
    listModels,
    preheat,
    close,
    agent,
    keyRing: ring,
    baseUrl: resolvedBase,
    _isFreeModelId: isFreeModelId,
    _filterFreeModels: filterFreeModels,
  };
}

// 配置写回（-provider railway set-url 等走通用 CLI，这里提供与其它定制供应商一致的落盘形状）
export function saveRailwayConfig({ baseUrl, keys } = {}, { file } = {}) {
  const cur = {
    baseUrl: loadProviderBaseUrl("railway", file ? { file } : {}) || DEFAULT_RAILWAY_BASE,
    keys: loadProviderKeys("railway", file ? { file } : {}),
  };
  saveProviderConfig("railway", {
    baseUrl: baseUrl ?? cur.baseUrl,
    keys: keys ?? cur.keys,
  }, file ? { file } : {});
}
