// Railway 定制供应商：opencode zen free 层的**多个 IP 出口**（第三方边缘反代 opencode.ai）。
// 本质：同一套 zen 契约，只是出口 IP 不同 ⇒ 免费额度按出口 IP 计，等于多份额度。
//
// 多出口轮流重试（顺序=优先级，缺省「新隧道 → 原 railway 反代」，判据/冷却全在 railway-endpoints.js）：
//   429（额度被上游收走）→ 该出口歇 1 小时；本请求内出局，换另一个出口不等待
//   5xx / 连不上 / 超时  → 该出口歇 3s；本请求内等 3s 换另一个 URL（两侧轮流），每出口最多 2 次
//   400 / 401 / 403      → 原样交回（换出口无用；FreeTierError、模型不存在的终局判决靠它）
// 上层（dispatcher / chat-pipeline）零感知——仍是同一个 `railway/<model>`。
//
// 与内置 opencode 的区别：
//   ① 只暴露 free 模型（上游 /models 会把付费模型一起列出来，这里过滤掉）；
//   ② 每个请求强制补 free-lane 形状（stream:true + 五个核心工具名），否则 403 FreeTierError；
//   ③ 带 opencode 身份头（UA + client/session/request/project），否则同样 403。
//
// 端点：<base>/zen/v1/models、<base>/zen/v1/chat/completions（base 取自出口列表）。
import crypto from "node:crypto";
import { createKeyRing } from "./keyring.js";
import { collectApiKeysGeneric, envInt, createAgent, getUndici, joinUrl } from "./base.js";
import { compatFetch } from "../compat.js";
import { loadProviderBaseUrl, loadProviderKeys, saveProviderConfig } from "../state.js";
import { ensureFreeLaneShape, aggregateChatSse } from "../free-lane.js";
import { genId, opencodeUa, digestIdTail } from "../opencode-identity.js";
import { joinModelId } from "./model-id.js";
import {
  UPSTREAM_RAILWAY_BASE,
  resolveRailwayBases,
  isSwapWorthyStatus,
  createEndpointRing,
  endpointTuning,
  runEndpointRotation,
} from "./railway-endpoints.js";

const { UndiciFetch } = getUndici();

/** 兼容旧常量：老代码（含测试）引用的「原 railway 反代根」。 */
export const DEFAULT_RAILWAY_BASE = UPSTREAM_RAILWAY_BASE;
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

export function createRailwayProvider({
  id = "railway",
  baseUrl,
  apiKeys,
  apiKey,
  connectTimeoutMs = envInt("MSLXDFF_RAILWAY_TIMEOUT_MS", 60_000),
  cooldownMs = envInt("MSLXDFF_RAILWAY_COOLDOWN_MS", 30_000),
  endpointCooldownMs,
  endpointQuotaCooldownMs,
  endpointRetryDelayMs,
  endpointRounds,
  fetchImpl,
  file,
  clock = Date.now,
} = {}) {
  if (id !== "railway") throw new Error(`railway provider id mismatch: ${id}`);
  const tuning = endpointTuning({
    shortCooldownMs: endpointCooldownMs,
    quotaCooldownMs: endpointQuotaCooldownMs,
    retryDelayMs: endpointRetryDelayMs,
    rounds: endpointRounds,
  });
  const endpoints = createEndpointRing(resolveRailwayBases({ baseUrl }), {
    cooldownMs: tuning.shortCooldownMs,
    quotaCooldownMs: tuning.quotaCooldownMs,
  });
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
  // 会话取值同 generic.js 的 resolveGoSession：已合规（ses_ 前缀）直接用；客户端透传的任意串
  // 做 sha1 摘要派生（稳定 + 合规）；无则每请求 fresh。绝不可裸拼 `ses_` + 客户端串——上游会反解
  // 低 12 位校验 counter，形状不符 403 FreeTierError（见 opencode-identity.js 头注）。
  function resolveSession(id) {
    const raw = String(id || "").trim();
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

  function buildHeaders(opts = {}) {
    return {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "User-Agent": opencodeUa(),
      "x-opencode-client": "desktop",
      "x-opencode-session": resolveSession(opts.sessionId),
      "x-opencode-request": genId("msg_"),
      "x-opencode-project": "global",
    };
  }

  /** 单出口一发（不含判据，成败交由编排裁决）。 */
  async function postTo(base, outBody, opts, key) {
    const headers = buildHeaders(opts);
    if (key) headers.Authorization = `Bearer ${key}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`railway timed out after ${connectTimeoutMs}ms`)), connectTimeoutMs);
    try {
      return await fetchImpl(joinUrl(base, CHAT_PATH), {
        method: "POST",
        headers,
        body: JSON.stringify(outBody),
        signal: ac.signal,
        ...(dispatcher ? { dispatcher } : {}),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** 一发上游的分类：ok / quota(429) / swap(5xx 或连不上) / fatal(其它 4xx)。 */
  function classifyResponse(res, key) {
    if (res.status < 400) return { kind: "ok", result: res };
    if (key) ring.onError(key);
    if (res.status === 429) return { kind: "quota", result: res };
    if (isSwapWorthyStatus(res.status)) return { kind: "swap", result: res };
    return { kind: "fatal", result: res };
  }

  /** 出口编排放账：成功清冷却、5xx 短冷却、429 长冷却。 */
  const endpointHooks = {
    onOk: (base) => endpoints.noteOk(base),
    onSwap: (base) => endpoints.noteExhausted(base),
    onQuota: (base) => endpoints.noteQuotaExhausted(base),
  };

  async function chat(body, opts = {}) {
    const wantStream = body?.stream === true;
    // free-lane 强制 stream:true：非流式请求在这里补形状，聚合回 JSON 后再返回。
    const outBody = { ...body, stream: true };
    ensureFreeLaneShape(outBody);
    const outcome = await runEndpointRotation({
      bases: endpoints.order(),
      rounds: tuning.rounds,
      retryDelayMs: tuning.retryDelayMs,
      ...endpointHooks,
      attempt: async (base) => {
        const key = ring.size ? ring.next() : null;
        try {
          return classifyResponse(await postTo(base, outBody, opts, key), key);
        } catch (err) {
          if (key) ring.onError(key);
          return { kind: "swap", err };                  // 连不上 / 超时：等 3s 换另一个 URL
        }
      },
    });
    if (outcome.kind === "ok") {
      const res = outcome.result;
      return wantStream ? res : aggregateChatSse(res);   // 客户端要非流式：SSE 聚合回 JSON
    }
    if (outcome.result) return outcome.result;           // 交回上游原响应（429 / 5xx / 其它 4xx），body 完好
    throw outcome.err || new Error("railway: no endpoint available");
  }

  let modelsCache = { at: 0, list: [] };
  const MODELS_TTL_MS = 10 * 60 * 1000;

  async function fetchModels(base) {
    const key = ring.size ? ring.next() : null;
    const headers = { "Accept": "application/json", "User-Agent": opencodeUa() };
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await fetchImpl(joinUrl(base, MODELS_PATH), {
      headers,
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (!res.ok) {
      const err = new Error(`railway models: http ${res.status}`);
      err.status = res.status;
      try { await res.body?.cancel?.(); } catch {}
      throw err;
    }
    const j = await res.json();
    return filterFreeModels(j?.data);
  }

  async function listModels() {
    if (clock() - modelsCache.at < MODELS_TTL_MS && modelsCache.list.length) return modelsCache.list;
    const outcome = await runEndpointRotation({
      bases: endpoints.order(),
      rounds: tuning.rounds,
      retryDelayMs: tuning.retryDelayMs,
      ...endpointHooks,
      attempt: async (base) => {
        try {
          return { kind: "ok", result: await fetchModels(base) };
        } catch (err) {
          const status = Number(err?.status) || 0;
          if (status === 429) return { kind: "quota", err };
          if (status >= 400 && status < 500) return { kind: "fatal", err };   // 401/403/404：换出口无益
          return { kind: "swap", err };
        }
      },
    });
    if (outcome.kind !== "ok" || !outcome.result) return modelsCache.list; // 全失败：给上一次缓存（首次空表）
    const list = outcome.result.map((m) => ({
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
    bases: [...endpoints.bases],
    orderBases: () => endpoints.order(),
    endpointCooldownUntil: (base) => endpoints.cooldownUntil(base),
    tuning: { ...tuning },
    baseUrl: endpoints.bases[0] || DEFAULT_RAILWAY_BASE,
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