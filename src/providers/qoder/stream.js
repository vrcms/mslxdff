// qoder 真流式转发：上游 Response.body → OpenAI SSE Response（边收边转，不攒数组）。
// 对标 traework chat.js reshapeSoloStream（reader.read 循环 + sendChunk 即时写）。
// usage 只在尾帧出现：收到即记，附在 finish chunk 上一次发出（与旧回放语义一致）。
import { extractDelta } from "./sse.js";

// SSE 缓冲上限：未完结行超 2MiB 立即中断（内存保护，对齐外部参照实现 defaultMaxSseBufferChars）
const MAX_BUFFER_CHARS = 2 * 1024 * 1024;

// 空轮排障用的临时日志开关：QODER_DEBUG_STREAM=1 才输出，默认静默（问题定位后可摘）
const DBG_STREAM = () => process.env.QODER_DEBUG_STREAM === "1";
const sdbg = (...a) => { if (DBG_STREAM()) console.log("[qoder-stream]", ...a); };
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

export function reshapeQoderStream(upstreamRes, { model, chatId, prefetched = [] }) {
  const src = upstreamRes.body;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  // 预读帧（chat.js 为取流内判决而先读的字节）原样回灌：既不丢内容也不重复，
  // 判决帧会在这里被正常解析并抛错，同时 chat.js 已用同一批帧定出状态码挂上门面。
  let buf = prefetched.map((b) => dec.decode(b, { stream: true })).join("");
  let usage = null;
  // 收尾判定与 aggregate 同构：上游给过 finish_reason 一律优先，全程没给才兜底（tool_calls > stop）
  let upstreamFinish = "";
  let sawToolCalls = false;
  let sawContent = false;
  let finishSent = false;
  const stream = new ReadableStream({
    async start(ctrl) {
      const reader = src.getReader();
      const send = (t) => ctrl.enqueue(enc.encode(t));
      let chunkIdx = 0;
      let contentLen = 0;
      let lineIdx = 0;
      try {
        sdbg(`[enter] model=${model} chatId=${chatId} ct=${upstreamRes.headers.get("content-type")} status=${upstreamRes.status}`);
        // role: assistant will be attached on first real delta to avoid premature payload commit
        for (;;) {
          const { done, value } = await reader.read();
          if (value) {
            const text = dec.decode(value, { stream: !done });
            buf += text;
            sdbg(`[chunk#${chunkIdx++}] bytes=${value.byteLength} done=${done} decodedLen=${text.length} raw=${JSON.stringify(text.slice(0, 500))}`);
          }
          const lines = buf.split("\n");
          buf = lines.pop();
          sdbg(`[buf] lines=${lines.length} leftover=${JSON.stringify(buf.slice(0, 200))}`);
          for (const raw of lines) {
            const line = raw.replace(/\r$/, "");
            lineIdx++;
            if (!line.startsWith("data:")) { sdbg(`[line#${lineIdx}] non-data: ${JSON.stringify(line.slice(0, 200))}`); continue; }
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") { sdbg(`[line#${lineIdx}] skip: ${JSON.stringify(payload)}`); continue; }
            const d = extractDelta(payload);
            sdbg(`[line#${lineIdx}] payload=${JSON.stringify(payload.slice(0, 800))}`);
            sdbg(`[line#${lineIdx}] parsed keys=${Object.keys(d).join(",")} content=${JSON.stringify((d.content || "").slice(0, 200))} reasoning=${JSON.stringify((d.reasoning || "").slice(0, 200))} toolCalls=${(d.toolCalls || []).length} usageIn=${d.usageIn} usageOut=${d.usageOut} err=${!!d.err}`);
            if (d.err) { sdbg(`[line#${lineIdx}] ERROR from extractDelta: ${JSON.stringify(d.err)}`); throw d.err; }
            if (d.usageIn || d.usageOut) {
              usage = { prompt_tokens: d.usageIn, completion_tokens: d.usageOut, total_tokens: d.usageIn + d.usageOut };
              sdbg(`[usage] ${JSON.stringify(usage)}`);
            }
            if (d.finishReason) upstreamFinish = d.finishReason;
            const delta = {};
            if (!sawContent) delta.role = "assistant";
            if (d.content) { delta.content = d.content; contentLen += d.content.length; sawContent = true; }
            if (d.reasoning) { delta.reasoning_content = d.reasoning; sawContent = true; }
            if (d.toolCalls) { delta.tool_calls = d.toolCalls; sawToolCalls = true; sawContent = true; }
            if (Object.keys(delta).length) send(openaiChunk({ model, chatId, delta }));
            sdbg(`[acc] line#=${lineIdx} sawContent=${sawContent} contentLen=${contentLen} upstreamFinish=${upstreamFinish} usage=${JSON.stringify(usage)}`);
          }
          // 完整行消费完毕后再判越限：leftover 超大不得把同 chunk 里的合法帧连坐丢弃（评审路1 P1#4）
          if (buf.length > MAX_BUFFER_CHARS) {
            sdbg(`[buffer-limit] leftover=${buf.length} chars → abort stream`);
            throw { kind: "upstream", status: 502, detail: "qoder SSE buffer exceeded 2MiB limit" };
          }
          if (done) break;
        }
        sdbg(`[end] totalChunks=${chunkIdx} totalLines=${lineIdx} sawContent=${sawContent} contentLen=${contentLen} upstreamFinish=${upstreamFinish} usage=${JSON.stringify(usage)}`);
        if (!sawContent && !usage) {
          sdbg(`[empty-stream] sawContent=false usage=null → throw 502 empty upstream stream`);
          throw { kind: "upstream", status: 502, detail: "empty upstream stream" };
        }
        const finish = upstreamFinish || (sawToolCalls ? "tool_calls" : "stop");
        send(openaiChunk({ model, chatId, delta: {}, finish, usage }));
        send("data: [DONE]\n\n");
        finishSent = true;
      } catch (e) {
        sdbg(`[catch] finishSent=${finishSent} e=${JSON.stringify(e?.message || e)}`);
        if (!finishSent) {
          if (sawContent) { try { send(openaiChunk({ model, chatId, delta: {} })); } catch {} }
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
