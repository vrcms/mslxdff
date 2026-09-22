// 通用（带 key）供应商的 responses 通道：muse-spark* 这类模型上游只挂 /responses，
// 打同 host 的 /chat/completions 会 503 "Endpoint is unavailable"（ocgo 实测 2026-09-22）。
// 判定单一来源 = isResponsesModel（models.dev 模型级 provider.npm + muse-spark 前缀兜底），
// 与 GET /v1/models 的 capabilities.upstreamApi 同源，新模型无需改码。
//
// 契约：run() 的出参恒为 **chat 形状**（SSE 或 JSON），调用方无需再判分支。
//   · 流式优先 @ai-sdk/openai 的 responses 适配器（含加密思考往返，ADR-0017 复用）；
//   · SDK 不可用 / 非流式 → 原生 fetch + chatToResponsesBody 正转换 + 反向整形。
// key 轮换、退避重试、_t 计时与 createChatRunner（base.js）同语义，避免两条通道行为漂移。
import { chatToResponsesBody, toChatResponse, reshapeResponsesSse } from "../upstream-responses.js";
import { attemptOnceResponsesSdk } from "../upstream-engine/sdk/responses.js";
import { ENGINE_MARKER } from "../upstream-engine/sdk/chat.js";
import { sleep } from "./base.js";

/** 供应商 id → env 片段（`my-api` → `MY_API`），与 providerKeyEnv 同规则 */
export function envSlug(id) {
  return String(id || "").toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/**
 * responses 端点路径：显式入参 > env `MSLXDFF_<ID>_RESPONSES_PATH` > 缺省 `/responses`。
 * 归一为以 `/` 开头（joinUrl 会再拼 baseUrl）。
 */
export function resolveResponsesPath(id, responsesPath) {
  const raw = responsesPath || process.env[`MSLXDFF_${envSlug(id)}_RESPONSES_PATH`] || "";
  const s = String(raw).trim();
  if (!s) return "/responses";
  return s.startsWith("/") ? s : `/${s}`;
}

/**
 * 建 responses 通道。
 * @param {object} o
 * @param {string} o.id 供应商 id（用于报错文案与 providerName）
 * @param {string} o.url 已拼好的 responses 绝对 URL
 * @param {number} o.connectTimeoutMs 单次尝试超时
 * @param {object} o.retry 重试表（与 createChatRunner 同形状：network/429/50x → {attempts, delayMs}）
 * @param {number} o.cooldownMs 全 key 冷却时的人话报错文案用
 * @param {boolean} o.sdkEnabled 是否允许走 AI SDK responses 适配器（流式路径）
 * @param {Function} o.buildHeaders (body, key, opts) → headers
 * @param {Function} o.fetchImpl 注入的 fetch（连接池/测试接缝）
 * @param {object} [o.dispatcher] undici Agent
 */
export function createResponsesChannel({
  id,
  url,
  connectTimeoutMs = 30_000,
  retry = {},
  cooldownMs = 30_000,
  sdkEnabled = true,
  buildHeaders,
  fetchImpl,
  dispatcher = null,
} = {}) {
  async function attemptOnce(body, key, opts) {
    const headers = buildHeaders ? buildHeaders(body, key, opts) : {};
    const wantsStream = body?.stream !== false;
    if (sdkEnabled && wantsStream) {
      try {
        const r = await attemptOnceResponsesSdk({
          url, body, headers, providerName: id, marker: ENGINE_MARKER, fetchImpl,
        });
        if (r) return r; // 适配器已产出 chat SSE
      } catch (e) {
        if (!e || (!e._sdkLoadFailed && !e._sdkUnsupported)) throw e;
        // SDK 装载失败 / URL 异形 → 落原生兜底（保底不变差）
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${id} timed out after ${connectTimeoutMs}ms`)), connectTimeoutMs);
    try {
      const fetchOpts = { method: "POST", headers, body: JSON.stringify(chatToResponsesBody(body)), signal: controller.signal };
      if (dispatcher) fetchOpts.dispatcher = dispatcher;
      const res = await fetchImpl(url, fetchOpts);
      if (!res.ok) return res;
      if (wantsStream) return reshapeResponsesSse(res, body?.model);
      const json = await res.json().catch(() => null);
      return json ? toChatResponse(res, json) : res;
    } finally {
      clearTimeout(timer);
    }
  }

  /** key 轮换 + 退避重试 + _t 计时；语义对齐 base.js 的 createChatRunner.runChat */
  async function run(body, activeRing, sourceKey, opts) {
    const t0 = performance.now();
    const attempts = [];
    let waitMs = 0;
    const key = activeRing.next();
    if (!key && activeRing.size > 0) {
      const err = new Error(`${id}: all API keys are in cooldown (last error < ${cooldownMs}ms ago) — provider temporarily unavailable`);
      err._t = { attempts: [], waitMs: 0, totalMs: Math.round(performance.now() - t0), cooldownMs };
      throw err;
    }
    for (let attempt = 0; ; attempt++) {
      const t = performance.now();
      let result;
      try {
        result = await attemptOnce(body, key, opts);
      } catch (err) {
        result = err;
      }
      attempts.push({ attempt, type: result instanceof Error ? "network" : `http${result?.status}`, ms: Math.round(performance.now() - t) });
      if (result instanceof Error) {
        const entry = retry?.network;
        if (entry && attempt < entry.attempts) { await sleep(entry.delayMs); waitMs += entry.delayMs; continue; }
        activeRing.onError(key);
        result._t = { attempts, waitMs, totalMs: Math.round(performance.now() - t0) };
        throw result;
      }
      const entry = retry?.[result.status];
      if (entry && attempt < entry.attempts) { await sleep(entry.delayMs); waitMs += entry.delayMs; continue; }
      if (result.status === 401 || result.status === 403 || result.status === 429 || result.status >= 500) activeRing.onError(key);
      try { result._t = { attempts, waitMs, totalMs: Math.round(performance.now() - t0) }; } catch {}
      return result;
    }
  }

  return { url, attemptOnce, run };
}
