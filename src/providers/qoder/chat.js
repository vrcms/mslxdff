// qoder 对话服务：上游恒 stream:true；请求方 stream=true → 真流式转发边收边吐，
// false → 聚合回 JSON。装配走 request.js，帧格式走 sse.js，两条管线共享。
import { compatFetch, timeoutSignal } from "../../compat.js";
import { normalizeRegion } from "./constants.js";
import { buildUpstreamRequest } from "./request.js";
import { reshapeQoderStream } from "./stream.js";
import { aggregateQoderStream, toCompletionJson } from "./aggregate.js";
import { errorStatus } from "./sse.js";

function errRes(status, msg, type = "upstream_error") {
  return new Response(JSON.stringify({ error: { message: msg, type } }), { status, headers: { "Content-Type": "application/json" } });
}

function mapUpstreamError(status, detail) {
  return { kind: status === 401 || status === 403 ? "auth" : "upstream", status, detail: String(detail || "").slice(0, 300) };
}

export function createChatService({ id = "qoder", fetchImpl, timeoutMs } = {}) {
  if (!fetchImpl) fetchImpl = compatFetch;

  // body: OpenAI chat 请求；sess: 已建 COSY 会话；region: 该账号所属区（每号独立选端点）。返回 Response。
  async function runChat(body, sess, region = "global") {
    const stream = body?.stream !== false;
    const model = body?.model || "qfmodel";
    const chatId = "chatcmpl-qoder-" + Math.random().toString(16).slice(2, 10);
    const tools = Array.isArray(body?.tools) && body.tools.length ? body.tools : null;
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const maxTokens = Number(body?.max_tokens) || 0;

    let upRes;
    try {
      const req = buildUpstreamRequest({ sess, region: normalizeRegion(region), model, messages, tools, maxTokens });
      upRes = await fetchImpl(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.bodyStr,
        signal: timeoutSignal(timeoutMs || 120_000),
      });
    } catch (e) {
      const detail = String(e?.message || e).slice(0, 300);
      if (stream) return reshapeQoderStream(new Response("data: [DONE]\n\n"), { model, chatId });
      return errRes(502, detail);
    }
    if (upRes.status !== 200) {
      const detail = await upRes.text().catch(() => "");
      const e = mapUpstreamError(upRes.status, detail);
      if (stream) {
        // 首包错误也走流内 error 事件（与旧 reshapeStream catch 语义一致：200 + event:error + DONE）
        const enc = new TextEncoder();
        const s = new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(`data: ${JSON.stringify({ id: chatId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: null }] })}\n\n`));
            c.enqueue(enc.encode(`event: error\ndata: ${JSON.stringify({ message: e.detail, type: e.kind })}\n\ndata: [DONE]\n\n`));
            c.close();
          },
        });
        return new Response(s, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return errRes(errorStatus(e), e.detail, e.kind);
    }
    if (stream) return reshapeQoderStream(upRes, { model, chatId });
    try {
      const agg = await aggregateQoderStream(upRes);
      const out = toCompletionJson({ model, chatId, ...agg });
      return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
    } catch (e) {
      return errRes(errorStatus(e), String(e?.detail || e?.message || e).slice(0, 300), e?.kind || "upstream_error");
    }
  }

  return { runChat };
}
