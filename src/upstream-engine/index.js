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
      // 保留 legacy 的匿名重试语义（仅 !anonFirst 配置下存在）；free-429 的**请求内 v6 换出口**
      // 也走这条委派——重试环在 legacy.chat 里。
      // ⚠ 顺序契约（用户 2026-10-19）：先借人（组员/组长，用对方 IPv4 出口），全都用完才换出口。
      //   故 v6 换出口**默认关**，只有显式 MSLXDFF_V6_INREQUEST_ROTATE=1 才委派；
      //   默认把 429 原样返回，交给 chat-pipeline 去试组员/组长。
      const v6RotateOn = (() => {
        const raw = process.env.MSLXDFF_V6_INREQUEST_ROTATE;
        if (raw === undefined || raw === null || raw === "") return false;
        const s = String(raw).trim().toLowerCase();
        return !(s === "0" || s === "false" || s === "off" || s === "no");
      })();
      const canRotate = v6RotateOn && typeof dispatcher?.rotateFor === "function";
      // 原语义：撞 429 且是 free 模型，且（非匿名首试 或 有 v6 池可换址）⇒ 委派 legacy 重试环。
      // 新语义：**只有显式开启 v6 请求内换址时才委派**；默认 429 原样返回，交给上层去借人
      // （组员/组长，用对方 IPv4 出口），符合用户 2026-10-19 的「先借人再换出口」顺序。
      if (res.status === 429 && isFreeModel(body?.model) && (anonFirst ? canRotate : v6RotateOn)) return legacy.chat(body);
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
