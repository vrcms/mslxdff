// DeepSeek 供应商工厂：把 chat.deepseek.com 免费 web/移动端对话包装成 OpenAI 兼容模型
// 模型：deepseek/chat、deepseek/reasoner、deepseek/chat-search、deepseek/reasoner-search
import { collectApiKeysGeneric, envInt, getUndici } from "../base.js";
import { loadProviderKeys } from "../../state.js";
import { createAuthPool } from "./auth.js";
import { runDeepseekChat } from "./chat.js";
import { createDeepseekSseParser } from "./bridge.js";
import { DEEPSEEK_DEFAULT_BASE } from "./pow.js";
import { dsDebug, dsDump } from "./debug.js";

const { UndiciFetch } = getUndici();

// 对外 id 带 -free 后缀（ADR-0002 免费过滤 + 客户端一眼识别免费）；上游 flags 由 bridge.mapModelToFlags 按 includes 判定，后缀不影响
// expert = 官网「专家模式」（completion body model_type:"expert"，TQZHR 映射 deepseek-{chat,reasoner}-expert）
export const DEEPSEEK_MODELS = [
  { id: "deepseek-chat-free", object: "model", owned_by: "deepseek" },
  { id: "deepseek-reasoner-free", object: "model", owned_by: "deepseek" },
  { id: "deepseek-chat-search-free", object: "model", owned_by: "deepseek" },
  { id: "deepseek-reasoner-search-free", object: "model", owned_by: "deepseek" },
  { id: "deepseek-chat-expert-free", object: "model", owned_by: "deepseek" },
  { id: "deepseek-reasoner-expert-free", object: "model", owned_by: "deepseek" },
];

export function createDeepseekProvider({
  id = "deepseek",
  baseUrl,
  apiKeys,
  apiKey,
  connectTimeoutMs = envInt("MSLXDFF_DEEPSEEK_TIMEOUT_MS", 30_000),
  cooldownMs = envInt("MSLXDFF_DEEPSEEK_COOLDOWN_MS", 30_000),
  fetchImpl,
  file,
} = {}) {
  const resolvedBase = String(baseUrl || DEEPSEEK_DEFAULT_BASE).trim().replace(/\/+$/, "");
  if (!fetchImpl) fetchImpl = UndiciFetch;

  const keys = collectApiKeysGeneric(id, apiKeys, apiKey, (pid) => loadProviderKeys(pid, file ? { file } : {}));
  const authPool = createAuthPool({ tokens: keys, cooldownMs });

  let modelsCache = null;
  async function listModels() {
    if (modelsCache) return modelsCache;
    modelsCache = DEEPSEEK_MODELS.map((m) => ({ ...m, id: `${id}/${m.id}` }));
    return modelsCache;
  }

  async function chat(body) {
    const out = await runDeepseekChat({
      body,
      authPool,
      fetchImpl,
      baseUrl: resolvedBase,
      connectTimeoutMs,
    });

    if (out.kind === "json") {
      return new Response(JSON.stringify(out.data), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // 流式：把上游 DeepSeek SSE 翻译为 OpenAI chat.completion.chunk 流，读完后无痕删会话
    return new Response(buildOpenAiSseStream({ upstream: out.res, model: body?.model || "deepseek/chat", cleanup: out.cleanup, startKind: startKind(body) }), {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  }

  async function chatWithKeys(body, keys) {
    const tmpPool = createAuthPool({ tokens: keys || [], cooldownMs });
    const out = await runDeepseekChat({ body, authPool: tmpPool, fetchImpl, baseUrl: resolvedBase, connectTimeoutMs });
    if (out.kind === "json") {
      return new Response(JSON.stringify(out.data), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(buildOpenAiSseStream({ upstream: out.res, model: body?.model || "deepseek/chat", cleanup: out.cleanup, startKind: startKind(body) }), {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  }

  async function close() {}

  return {
    id,
    chat,
    chatWithKeys,
    listModels,
    preheat: async () => ({ ok: true }),
    close,
    keyRing: { available: () => authPool.available(), size: authPool.size, cooldownMs },
    _authPool: authPool,
    baseUrl: resolvedBase,
  };
}

function startKind(body) {
  const id = String(body?.model || "");
  return id.includes("reasoner") ? "reasoning" : "content";
}

function buildOpenAiSseStream({ upstream, model, cleanup, startKind: initialKind = "content" }) {
  const parse = createDeepseekSseParser({ startKind: initialKind });
  const completionId = `chatcmpl-deepseek-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  let first = true;
  let finished = false;
  const stat = { chunks: 0, bytes: 0, content: 0, reasoning: 0, finishEv: 0, t0: Date.now() };

  function frame(delta, finishReason = null) {
    return `data: ${JSON.stringify({
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          dsDebug("sse-stream", { event: "upstream-done", model, ...stat, elapsedMs: Date.now() - stat.t0, EMPTY_STREAM: stat.chunks === 0 || (stat.content === 0 && stat.reasoning === 0) });
          if (!finished) {
            finished = true;
            controller.enqueue(encoder.encode(frame({}, "stop")));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          }
          if (cleanup) { try { await cleanup(); } catch {} cleanup = null; }
          controller.close();
          return;
        }
        stat.chunks++;
        stat.bytes += value?.byteLength || 0;
        const text = decoder.decode(value, { stream: true });
        dsDump("sse-stream", `upstream chunk #${stat.chunks} model=${model}`, text, 3000);
        const events = parse(text);
        dsDebug("sse-stream", { event: "parsed", chunkNo: stat.chunks, events: events.length, kinds: events.map((e) => (e.finish ? `finish:${e.finish}` : e.reasoning ? "reasoning" : e.content ? "content" : JSON.stringify(e).slice(0, 60))).join("|") });
        for (const ev of events) {
          if (first) {
            first = false;
            controller.enqueue(encoder.encode(frame({ role: "assistant", content: "" })));
          }
          // 上游拒绝（event:hint input_exceeds_limit / rate_limit_reached 等）：透传为 OpenAI error 事件，绝不静默
          if (ev.error && !finished) {
            finished = true;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: ev.error, type: "upstream_error", ...(ev.finishReason ? { finish_reason: ev.finishReason } : {}) } })}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            break;
          }
          if (ev.reasoning) { stat.reasoning += ev.reasoning.length; controller.enqueue(encoder.encode(frame({ reasoning_content: ev.reasoning }))); }
          if (ev.content) { stat.content += ev.content.length; controller.enqueue(encoder.encode(frame({ content: ev.content }))); }
          if (ev.finish && !finished) {
            stat.finishEv++;
            finished = true;
            controller.enqueue(encoder.encode(frame({}, ev.finish)));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          }
        }
      } catch (err) {
        dsDebug("sse-stream", { event: "reader-error", model, ...stat, error: String(err?.message || err) });
        if (!finished) {
          finished = true;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: String(err?.message || err), type: "upstream_error" } })}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
        if (cleanup) { try { await cleanup(); } catch {} cleanup = null; }
        controller.close();
      }
    },
    async cancel() {
      dsDebug("sse-stream", { event: "downstream-cancel", model, ...stat });
      try { await reader.cancel(); } catch {}
      if (cleanup) { try { await cleanup(); } catch {} cleanup = null; }
    },
  });
}
