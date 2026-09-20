// CodeArts 聊天服务：上游 body/头组装 + SDK-HMAC-SHA256 签名 + 401 刷新重试 + 环形切号。
// 上游恒 stream:true（chatBodyV2 契约）；流式客户端转 OpenAI SSE，非流式聚合回 JSON。
import crypto from "node:crypto";
import { joinUrl } from "../base.js";
import { createTransport } from "../../transport/index.js";
import { SNAP_BASE, EP_CHAT_V2, chatBaseHeaders, MAAS_TYPE_HEADER, MAAS_BENEFIT } from "./const.js";
import { signRequest } from "./sign.js";
import { newChatId, preflightResponse, sseToOpenAIResponse, aggregateToCompletion, UpstreamEventError } from "./stream.js";

const MODEL_RULES = [
  { match: (m) => String(m || "").toLowerCase().includes("deepseek"), scope: "all" },
  { match: (m) => /(^kimi-|kimi)/i.test(String(m || "")), scope: "toolCalls" },
];

// DeepSeek 系思考模式要求 assistant 消息回传 reasoning_content，缺失补 " " 占位（ADR-0001 同款）。
export function injectReasoningPlaceholder(messages, model) {
  const rule = MODEL_RULES.find((r) => r.match(model));
  if (!rule || !Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (m?.role !== "assistant") return m;
    if (typeof m.reasoning_content === "string" && m.reasoning_content.length) return m;
    if (rule.scope === "toolCalls" && !(Array.isArray(m.tool_calls) && m.tool_calls.length)) return m;
    return { ...m, reasoning_content: " " };
  });
}

const PASSTHROUGH_KEYS = ["temperature", "top_p", "max_tokens", "max_completion_tokens", "reasoning_effort", "tools", "tool_choice", "stop", "presence_penalty", "frequency_penalty", "response_format", "user", "n", "seed"];

export function buildUpstreamBody(body, { chatId, upstreamModel }) {
  const out = {
    model: upstreamModel,
    stream: true, // v2 端点契约：恒流式，非流式由本层聚合
    messages: injectReasoningPlaceholder(body?.messages || [], upstreamModel),
    prompt_cache_key: chatId,
    tool_stream: true,
    chat_id: chatId,
  };
  for (const k of PASSTHROUGH_KEYS) {
    if (body?.[k] !== undefined && body?.[k] !== null) out[k] = body[k];
  }
  return out;
}

// Session-Id：由 chatId 派生的稳定会话标识（prompt cache 亲和，对齐 Go sessionIDFor）。
function sessionIdFor(chatId) {
  return crypto.createHash("sha256").update(`codearts-session:${chatId}`, "utf8").digest("hex").slice(0, 32);
}

function stripOwnPrefix(model, providerId) {
  const s = String(model || "");
  const i = s.indexOf("/");
  if (i <= 0) return s;
  return s.slice(0, i).toLowerCase() === String(providerId || "").toLowerCase() ? s.slice(i + 1) : s;
}

export function createChatService({
  id = "codearts",
  baseUrl = SNAP_BASE,
  chatPath = EP_CHAT_V2,
  fetchImpl,
  dispatcher,
  authPool,
  catalog,
  connectTimeoutMs = 30_000,
  clock = Date.now,
  } = {}) {
  const resolvedBase = String(baseUrl).trim().replace(/\/+$/, "") || SNAP_BASE;
  const transport = createTransport({ fetchImpl, dispatcher, keepAlive: !!dispatcher, timeoutMs: connectTimeoutMs, retry: {} });

  async function sendOnce({ bodyStr, account, benefit, chatId, sessionId, traceId }) {
    const url = joinUrl(resolvedBase, chatPath);
    const h = chatBaseHeaders(account.securityToken, traceId);
    if (benefit) h[MAAS_TYPE_HEADER] = MAAS_BENEFIT;
    const { headers } = signRequest({ method: "POST", url, headers: h, body: bodyStr, cred: account });
    // Chat-Id / Session-Id 在签名之后追加（对齐官方客户端：不进 SignedHeaders）。
    headers["chat-id"] = chatId;
    headers["session-id"] = sessionId;
    return transport.request({ url, method: "POST", headers, body: bodyStr, stream: true, timeoutMs: connectTimeoutMs });
  }

  function errRes(status, msg, code) {
    return new Response(JSON.stringify({ error: { message: msg, type: "upstream_error", ...(code ? { code } : {}) } }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function withTiming(res, t0) {
    try { res._t = { attempts: [], waitMs: 0, totalMs: Math.round(clock() - t0) }; } catch {}
    return res;
  }

  /**
   * 跑一次对话。body.model 已由 dispatcher 剥前缀（容忍自带前缀）。
   * @returns {Promise<Response>} 流式 → OpenAI SSE；非流式 → chat.completion JSON
   */
  async function runChat(body, activeRing, opts = {}) {
    const t0 = clock();
    const requestedModel = String(body?.model || "");
    const rawModel = stripOwnPrefix(requestedModel, id);
    const upstreamModel = catalog?.canonical(rawModel) || rawModel;
    const chatId = newChatId(body, opts);
    const sessionId = sessionIdFor(chatId);
    const upstreamBody = buildUpstreamBody(body, { chatId, upstreamModel });
    const bodyStr = JSON.stringify(upstreamBody);
    const isStream = body?.stream === true;
    let lastErr = null;

    const maxTries = Math.max(1, activeRing.size || 1);
    for (let attempt = 0; attempt < maxTries; attempt++) {
      const blob = activeRing.next();
      if (!blob) break;
      let account;
      try {
        account = await authPool.getCredential(blob);
      } catch (err) {
        try { activeRing.onError(blob); } catch {}
        lastErr = err;
        continue; // 死号/不在池：换下一个账号
      }
      const benefit = catalog?.isBenefit ? catalog.isBenefit(account.userId, upstreamModel) : false;
      const traceId = crypto.randomBytes(8).toString("hex") + String(clock());
      let res;
      try {
        res = await sendOnce({ bodyStr, account, benefit, chatId, sessionId, traceId });
      } catch (err) {
        try { activeRing.onError(blob); } catch {}
        lastErr = err;
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        // STS 临时凭证失效：强制刷新重试一次，仍 401/403 换号
        authPool.invalidate(blob);
        let account2 = null;
        try { account2 = await authPool.getCredential(blob); } catch { /* 死号 → 换号 */ }
        if (account2) {
          const traceId2 = crypto.randomBytes(8).toString("hex") + String(clock());
          try { res = await sendOnce({ bodyStr, account: account2, benefit, chatId, sessionId, traceId: traceId2 }); } catch (err2) { lastErr = err2; try { activeRing.onError(blob); } catch {} continue; }
          if (res.status === 401 || res.status === 403) {
            try { await res.text(); } catch {}
            try { activeRing.onError(blob); } catch {}
            lastErr = new Error(`codearts auth still failing after refresh (http ${res.status})`);
            continue;
          }
        } else {
          try { activeRing.onError(blob); } catch {}
          continue;
        }
      }
      if (res.status >= 400) {
        const txt = await res.text().catch(() => "");
        if (res.status === 429 || res.status >= 500) try { activeRing.onError(blob); } catch {}
        return withTiming(errRes(res.status, `codearts upstream http ${res.status}: ${String(txt).slice(0, 300)}`), t0);
      }
      try {
        const pre = await preflightResponse(res); // HTTP 200 内嵌错误（排队/未注册/福利未领）→ 抛 UpstreamEventError
        if (isStream) return withTiming(sseToOpenAIResponse(pre, { model: requestedModel || upstreamModel, id: `chatcmpl-${chatId.slice(0, 12)}` }), t0);
        const data = await aggregateToCompletion(pre, { model: requestedModel || upstreamModel, id: `chatcmpl-${chatId.slice(0, 12)}` });
        return withTiming(new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } }), t0);
      } catch (err) {
        if (err instanceof UpstreamEventError) {
          if (err.status === 429 || err.status >= 500) try { activeRing.onError(blob); } catch {}
          return withTiming(errRes(err.status, `codearts upstream: ${err.message}`, err.code), t0);
        }
        try { activeRing.onError(blob); } catch {}
        lastErr = err;
        continue;
      }
    }
    throw Object.assign(lastErr || new Error("codearts: all accounts unavailable"), {
      _t: { attempts: [], waitMs: 0, totalMs: Math.round(clock() - t0) },
    });
  }

  return { runChat, buildUpstreamBody, injectReasoningPlaceholder, _sendOnce: sendOnce };
}
