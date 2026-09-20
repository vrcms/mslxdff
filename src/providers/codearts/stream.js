// 非流式聚合、chat_id 派生。解析纯函数见 ./sse.js。
import crypto from "node:crypto";
import { createSseState, scanLine, applyEvent, sortedToolCalls, embeddedErrorFromData, effectiveFinish, UpstreamEventError } from "./sse.js";

// chat.js 从这里拿错误类（保持单一导入面）。
export { UpstreamEventError };

// 只读到首个 data: 事件：正常帧原样回放（不破坏流式）；内嵌业务错误转 UpstreamEventError 供上层重试/冷却。
export async function preflightResponse(resp) {
  if (!resp?.body) return resp;
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  const prefix = [];
  let buf = "";
  const state = { pendingEvent: "" };
  const headers = new Headers(resp.headers);
  headers.delete("content-length");
  while (true) {
    const { done, value } = await reader.read();
    if (value?.length) {
      const chunk = dec.decode(value, { stream: true });
      prefix.push(chunk);
      buf += chunk;
    }
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const ev = scanLine(line, state);
      if (ev) {
        const err = embeddedErrorFromData(ev.data);
        if (err) {
          try { await reader.cancel(); } catch {}
          throw new UpstreamEventError(err.message, { status: err.status, code: err.message });
        }
        return replay(prefix, buf, reader, resp.status, headers);
      }
    }
    if (done) return replay(prefix, buf, null, resp.status, headers);
  }
}

function replay(chunks, tail, reader, status, headers) {
  const enc = new TextEncoder();
  let primed = false;
  const stream = new ReadableStream({
    async pull(controller) {
      if (!primed) {
        primed = true;
        for (const c of chunks) controller.enqueue(enc.encode(c));
        if (tail) controller.enqueue(enc.encode(tail));
        if (!reader) { controller.close(); return; }
      }
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) { controller.error(err); }
    },
    cancel() { try { reader?.cancel?.(); } catch {} },
  });
  return new Response(stream, { status, headers });
}

// chat_id 必须 32 位 hex（UUID 去连字符），否则上游报「请求参数错误：chat_id」。
export function newChatId(body, opts) {
  const raw = String(body?.chat_id || body?.conversation_id || opts?.sessionId || "").trim();
  const hex = raw.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length >= 32) return hex.slice(0, 32);
  return crypto.createHash("sha256").update(raw || crypto.randomUUID(), "utf8").digest("hex").slice(0, 32);
}

const chunkLine = (id, model, delta, finish) => {
  const choice = { index: 0, delta };
  if (finish) choice.finish_reason = finish;
  return `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [choice] })}\n\n`;
};

/** 上游 SSE → OpenAI SSE 流式转换（快照替换/增量混合语义，保证至少一个 finish chunk + [DONE]）。 */
export function sseToOpenAIResponse(resp, { model, id }) {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const reader = resp.body.getReader();
  let buf = "";
  const state = createSseState();
  let finishSent = false;
  const stream = new ReadableStream({
    async pull(controller) {
      const emit = (text) => controller.enqueue(enc.encode(text));
      const finishChunk = () => { if (!finishSent) { emit(chunkLine(id, model, {}, effectiveFinish(state))); finishSent = true; } };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (value?.length) buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            const ev = scanLine(line, state);
            if (!ev) continue;
            if (ev.data === "[DONE]") {
              finishChunk();
              emit("data: [DONE]\n\n");
              controller.close();
              return;
            }
            const beforeC = state.content.length, beforeR = state.reason.length;
            applyEvent(state, ev.event, ev.data);
            if (state.error) {
              emit(`event: error\ndata: ${JSON.stringify({ error: { message: `${state.error.code} ${state.error.msg}`.trim(), type: "upstream_error", code: "CODEARTS_STREAM_ERROR" } })}\n\n`);
              emit("data: [DONE]\n\n");
              controller.close();
              return;
            }
            const delta = {};
            if (state.reason.length > beforeR) delta.reasoning_content = state.reason.slice(beforeR);
            if (state.content.length > beforeC) delta.content = state.content.slice(beforeC);
            if (Object.keys(delta).length) emit(chunkLine(id, model, delta, ""));
            if (state.done) {
              finishChunk();
              emit("data: [DONE]\n\n");
              controller.close();
              return;
            }
          }
          if (done) {
            finishChunk();
            emit("data: [DONE]\n\n");
            controller.close();
            return;
          }
        }
      } catch (err) { controller.error(err); }
    },
    cancel() { try { reader.cancel(); } catch {} },
  });
  return new Response(stream, { status: resp.status, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" } });
}

/** 上游 SSE → OpenAI chat.completion JSON（非流式聚合；内嵌错误抛 UpstreamEventError）。 */
export async function aggregateToCompletion(resp, { model, id }) {
  const dec = new TextDecoder();
  const reader = resp.body.getReader();
  let buf = "";
  const state = createSseState();
  outer: while (true) {
    const { done, value } = await reader.read();
    if (value?.length) buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const ev = scanLine(line, state);
      if (ev) applyEvent(state, ev.event, ev.data);
      if (state.error || state.done) break outer;
    }
    if (done) break;
  }
  try { await reader.cancel(); } catch {}
  if (state.error) {
    const status = embeddedErrorFromData(JSON.stringify({ error_code: state.error.code, error_msg: state.error.msg }))?.status || 502;
    throw new UpstreamEventError(`${state.error.code} ${state.error.msg}`.trim(), { status, code: state.error.code });
  }
  const message = { role: "assistant", content: state.content };
  if (state.reason) message.reasoning_content = state.reason;
  const calls = sortedToolCalls(state);
  if (calls.length) {
    message.tool_calls = calls;
    if (!state.content) message.content = null;
  }
  const usage = state.usage
    ? { ...state.usage, total_tokens: (state.usage.prompt_tokens || 0) + (state.usage.completion_tokens || 0) }
    : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return {
    id: id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: effectiveFinish(state), logprobs: null }],
    usage,
  };
}
