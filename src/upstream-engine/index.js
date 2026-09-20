// 上游引擎选择（ADR-0017）：sdk=AI SDK wire 层（缺省），legacy=原实现（显式指定或 SDK 装载失败回退）。
// Note: 缺省即 sdk；chat 类走 /chat/completions（@ai-sdk/openai-compatible），
// responses 类（muse-spark*）走 /responses（@ai-sdk/openai）；非流式与 anon 重试委派 legacy，
// SDK 不可用自动回退并告警一次 — 见 .scratch/ai-sdk-upstream/{SPEC.md,SPEC-p4-turnon.md,SPEC-p3-responses.md} 与 docs/adr/0017
import { createUpstreamClient, createOpencodeHeaderBuilder } from "../upstream.js";
import { isResponsesModel } from "../upstream-responses.js";
import { isFreeModel } from "../models.js";
import { ensureFreeLaneShape } from "../free-lane.js";
import { createSdkChat } from "./sdk/chat.js";
import { createSdkResponses } from "./sdk/responses.js";
import { dispatcherFetch } from "./sdk/attempt.js";
import { resolveEngineMode } from "./mode.js";

export { resolveEngineMode };

export function createUpstreamEngine(opts = {}) {
  const legacy = createUpstreamClient(opts);
  const env = opts.env ?? process.env;
  if (resolveEngineMode(env) !== "sdk") return legacy;

  const baseUrl = opts.baseUrl || process.env.UPSTREAM_BASE_URL || "https://opencode.ai";
  const sdkFactory = opts.sdkFactory ?? createSdkChat;
  const responsesFactory = opts.responsesFactory ?? createSdkResponses;
  const { buildHeaders, anonFirst } = createOpencodeHeaderBuilder({
    authToken: opts.authToken || process.env.UPSTREAM_AUTH_TOKEN || "public",
  });
  const dispatcher = legacy.dispatcher;
  const fetchImpl = dispatcher ? dispatcherFetch(dispatcher) : undefined;
  const sdk = sdkFactory({ baseUrl, buildHeaders, providerName: "opencode", fetchImpl });
  const responses = responsesFactory({ baseUrl, buildHeaders, providerName: "opencode", fetchImpl });

  let sdkDown = false;
  let logged = false;

  async function chat(body) {
    // zen 免费层 agent 形状门禁（2026-09-18）：SDK 流式通道不经 legacy.chat，必须在这里补形状。
    // 非流式先委派 legacy（它在自己内部注入并把 SSE 聚合回 JSON，避免这里先改 stream 导致误判）。
    const wantsStream = body?.stream !== false;
    if (sdkDown || !wantsStream) return legacy.chat(body);
    if (isFreeModel(body?.model)) ensureFreeLaneShape(body);
    const useResponses = isResponsesModel(body?.model);
    try {
      const res = useResponses ? await responses.chat(body) : await sdk.chat(body);
      if (!logged) {
        logged = true;
        const via = useResponses ? "@ai-sdk/openai · responses" : "@ai-sdk/openai-compatible · chat";
        try { console.error(`[upstream-engine] sdk 引擎生效（${via}）`); } catch {}
      }
      // 保留 legacy 的匿名重试语义（仅 !anonFirst 配置下存在）
      if (res.status === 429 && !anonFirst && isFreeModel(body?.model)) return legacy.chat(body);
      return res;
    } catch (e) {
      if (e && e._sdkLoadFailed) {
        sdkDown = true;
        try { console.error(`[upstream-engine] ${e.message} — 回退 legacy 引擎`); } catch {}
        return legacy.chat(body);
      }
      throw e;
    }
  }

  return {
    chat,
    preheat: (args) => legacy.preheat(args),
    close: () => legacy.close(),
    headers: legacy.headers,
    buildHeaders: legacy.buildHeaders,
    get dispatcher() { return legacy.dispatcher; },
    get agent() { return legacy.agent; },
    [Symbol.asyncDispose]: () => legacy.close(),
  };
}
