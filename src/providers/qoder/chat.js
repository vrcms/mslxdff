// qoder 对话服务（转译 bridge.go CallQoder + chat.go）：恒 stream:true 上游；
// 请求方 stream=true → OpenAI SSE 透传；false → 聚合回 JSON。
import { compatFetch, timeoutSignal } from "../../compat.js";
import { getEndpoints, normalizeRegion } from "./constants.js";
import { buildCosyHeaders, pathSigFrom } from "./session.js";
import { cosyEncode } from "./encode.js";
import { buildQoderBody, mapModel } from "./payload.js";
import { extractDelta, errorStatus } from "./sse.js";

function errRes(status, msg, type = "upstream_error") {
  return new Response(JSON.stringify({ error: { message: msg, type } }), { status, headers: { "Content-Type": "application/json" } });
}

// 单账号单次对话：上流读流 + delta 回调；返回 usage 或抛 err
async function callQoder({ sess, region, model, messages, tools, maxTokens, fetchImpl, onDelta, timeoutMs = 120_000 }) {
  const ep = getEndpoints(region);
  const upstreamModel = mapModel(model);
  const { body, mcSource } = buildQoderBody({ template: undefined, userType: sess.identity.userType, model: upstreamModel, messages, tools, maxTokens });
  const url = ep.chatStreamURL;
  const bodyStr = cosyEncode(Buffer.from(JSON.stringify(body)));
  const headers = buildCosyHeaders(sess, pathSigFrom(url), bodyStr, "text/event-stream");
  headers["x-model-key"] = upstreamModel;
  headers["x-model-source"] = mcSource;
  headers["accept"] = "text/event-stream";
  const res = await fetchImpl(url, { method: "POST", headers, body: bodyStr, signal: timeoutSignal(timeoutMs) });
  if (res.status !== 200) {
    const detail = await res.text().catch(() => "");
    throw { kind: res.status === 401 || res.status === 403 ? "auth" : "upstream", status: res.status, detail: detail.slice(0, 300) };
  }
  // 读 SSE 行
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", usage = null, empty = true;
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: !done });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const raw of lines) {
      const line = raw.replace(/\r$/, "");
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      const d = extractDelta(payload);
      if (d.err) throw d.err;
      if (d.usageIn > 0 || d.usageOut > 0) usage = { prompt_tokens: d.usageIn, completion_tokens: d.usageOut, total_tokens: d.usageIn + d.usageOut };
      if (d.content || d.reasoning || d.toolCalls) {
        empty = false;
        onDelta?.(d);
      }
    }
    if (done) break;
  }
  if (empty && !usage) throw { kind: "upstream", status: 502, detail: "empty upstream stream" };
  return usage;
}

// 上游 delta 流 → OpenAI SSE Response
function reshapeStream(model, chatId, iter) {
  const enc = new TextEncoder();
  let usage = null, finish = "stop", done = false;
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (t) => ctrl.enqueue(enc.encode(t));
      const chunk = (delta, fin) => {
        const c = { id: chatId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: fin || null }] };
        if (usage && fin) c.usage = usage;
        send(`data: ${JSON.stringify(c)}\n\n`);
      };
      chunk({ role: "assistant" });
      try {
        for (const d of iter) {
          if (d.err) { throw d.err; }
          if (d.usageIn || d.usageOut) usage = { prompt_tokens: d.usageIn, completion_tokens: d.usageOut, total_tokens: d.usageIn + d.usageOut };
          const delta = {};
          if (d.content) delta.content = d.content;
          if (d.reasoning) delta.reasoning_content = d.reasoning;
          if (d.toolCalls) { delta.tool_calls = d.toolCalls; finish = "tool_calls"; }
          if (Object.keys(delta).length) chunk(delta);
        }
        chunk({}, finish);
        send("data: [DONE]\n\n");
      } catch (e) {
        chunk({}, null);
        send(`event: error\ndata: ${JSON.stringify({ message: String(e?.detail || e?.message || e), type: e?.kind || "upstream_error" })}\n\n`);
        send("data: [DONE]\n\n");
      }
      try { ctrl.close(); } catch {}
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
}

export function createChatService({ id = "qoder", fetchImpl, timeoutMs } = {}) {

  // body: OpenAI chat 请求；sess: 已建 COSY 会话；region: 该账号所属区（每号独立选端点）。返回 Response。
  async function runChat(body, sess, region = "global") {
    const model = body?.model || "qfmodel";
    const chatId = "chatcmpl-qoder-" + Math.random().toString(16).slice(2, 10);
    const stream = body?.stream !== false;
    const tools = Array.isArray(body?.tools) && body.tools.length ? body.tools : null;
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const deltas = [];
    try {
      const usage = await callQoder({ sess, region: normalizeRegion(region), model, messages, tools, maxTokens: Number(body?.max_tokens) || 0, fetchImpl, timeoutMs, onDelta: (d) => deltas.push(d) });
      if (stream) {
        // 已聚合完再回放成 SSE（上游恒流式，此处保证客户端拿到流）
        const gen = (function* () { for (const d of deltas) yield d; if (usage) yield { usageIn: usage.prompt_tokens, usageOut: usage.completion_tokens }; })();
        return reshapeStream(model, chatId, gen);
      }
      // 非流式聚合
      let content = "", reasoning = "";
      const toolCalls = [];
      for (const d of deltas) {
        content += d.content || "";
        reasoning += d.reasoning || "";
        if (d.toolCalls) toolCalls.push(...d.toolCalls);
      }
      const msg = { role: "assistant", content: content || (toolCalls.length ? null : "") };
      if (reasoning) msg.reasoning_content = reasoning;
      if (toolCalls.length) msg.tool_calls = toolCalls;
      return new Response(JSON.stringify({
        id: chatId, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: msg, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    } catch (e) {
      const status = errorStatus(e);
      const detail = String(e?.detail || e?.message || e).slice(0, 300);
      if (stream) {
        const enc = new TextEncoder();
        const s = new ReadableStream({ start(c) { c.enqueue(enc.encode(`data: ${JSON.stringify({ error: { message: detail, type: e?.kind || "upstream_error" } })}\n\ndata: [DONE]\n\n`)); c.close(); } });
        return new Response(s, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return errRes(status, detail, e?.kind || "upstream_error");
    }
  }

  return { runChat };
}
