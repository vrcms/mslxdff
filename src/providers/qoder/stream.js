// qoder 真流式转发：上游 Response.body → OpenAI SSE Response（边收边转，不攒数组）。
// 对标 traework chat.js reshapeSoloStream（reader.read 循环 + sendChunk 即时写）。
// usage 只在尾帧出现：收到即记，附在 finish chunk 上一次发出（与旧回放语义一致）。
import { extractDelta } from "./sse.js";

function openaiChunk({ model, chatId, delta, finish, usage }) {
  const c = {
    id: chatId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish || null }],
  };
  if (usage && finish) c.usage = usage;
  return `data: ${JSON.stringify(c)}\n\n`;
}

function errorEvent(e) {
  return `event: error\ndata: ${JSON.stringify({ message: String(e?.detail || e?.message || e), type: e?.kind || "upstream_error" })}\n\n`;
}

export function reshapeQoderStream(upstreamRes, { model, chatId }) {
  const src = upstreamRes.body;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = "";
  let usage = null;
  let finish = "stop";
  let sawContent = false;
  let finishSent = false;
  const stream = new ReadableStream({
    async start(ctrl) {
      const reader = src.getReader();
      const send = (t) => ctrl.enqueue(enc.encode(t));
      try {
        send(openaiChunk({ model, chatId, delta: { role: "assistant" } }));
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
            if (d.usageIn || d.usageOut) {
              usage = { prompt_tokens: d.usageIn, completion_tokens: d.usageOut, total_tokens: d.usageIn + d.usageOut };
            }
            const delta = {};
            if (d.content) { delta.content = d.content; sawContent = true; }
            if (d.reasoning) { delta.reasoning_content = d.reasoning; sawContent = true; }
            if (d.toolCalls) { delta.tool_calls = d.toolCalls; finish = "tool_calls"; sawContent = true; }
            if (Object.keys(delta).length) send(openaiChunk({ model, chatId, delta }));
          }
          if (done) break;
        }
        if (!sawContent && !usage) {
          throw { kind: "upstream", status: 502, detail: "empty upstream stream" };
        }
        send(openaiChunk({ model, chatId, delta: {}, finish, usage }));
        send("data: [DONE]\n\n");
        finishSent = true;
      } catch (e) {
        if (!finishSent) {
          try { send(openaiChunk({ model, chatId, delta: {} })); } catch {}
          try { send(errorEvent(e)); } catch {}
          try { send("data: [DONE]\n\n"); } catch {}
          finishSent = true;
        }
      }
      try { ctrl.close(); } catch {}
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
