// todaycn 出站成形：上游没有流式（202 + 轮询），客户端要 stream:true 时由本层**自造** OpenAI SSE 帧。
// 帧序（对齐 OpenAI 形状，客户端无需特判）：role delta → content delta / tool_calls delta → finish_reason → [DONE]。
// 非流式直接给 chat.completion JSON（同一份 completion 两种出法，避免两处口径漂移）。

const encoder = new TextEncoder();

/** OpenAI chat.completion 对象（message.content 为空且无 tool_calls 时 content 置 null，符合 OpenAI 约定）。 */
export function createCompletion({ id, model, content = "", toolCalls = [], created = Math.floor(Date.now() / 1000), usage = null } = {}) {
  const message = { role: "assistant", content: content || null };
  if (Array.isArray(toolCalls) && toolCalls.length) message.tool_calls = toolCalls;
  const completion = {
    id: id || `chatcmpl_${Math.random().toString(36).slice(2, 14)}`,
    object: "chat.completion",
    created,
    model: model || "todaycn",
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: message.tool_calls ? "tool_calls" : "stop",
      },
    ],
  };
  if (usage) completion.usage = usage;
  return completion;
}

function chunkFrame(completion, delta, finishReason = null) {
  return {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
  };
}

function frame(payload) {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

/** completion → OpenAI SSE 流。chunkChars>0 时把正文按该长度切多个 content delta（默认整段一帧）。 */
export function completionToSseStream(completion, { chunkChars = 0 } = {}) {
  const choice = completion?.choices?.[0] || {};
  const message = choice.message || {};
  const text = String(message.content ?? "");
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const finish = choice.finish_reason || "stop";
  return new ReadableStream({
    start(controller) {
      controller.enqueue(frame(chunkFrame(completion, { role: "assistant" })));
      if (calls.length) {
        controller.enqueue(
          frame(
            chunkFrame(completion, {
              tool_calls: calls.map((c, i) => ({ index: i, id: c.id, type: c.type || "function", function: c.function })),
            }),
          ),
        );
      } else if (text) {
        const step = chunkChars > 0 ? chunkChars : text.length;
        for (let i = 0; i < text.length; i += step) {
          controller.enqueue(frame(chunkFrame(completion, { content: text.slice(i, i + step) })));
        }
      }
      controller.enqueue(frame(chunkFrame(completion, {}, finish)));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

/** 同一份 completion：stream=true 出 SSE，否则出 JSON。 */
export function completionToResponse(completion, { stream = false, streamChunkChars = 0 } = {}) {
  if (!stream) {
    return new Response(JSON.stringify(completion), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(completionToSseStream(completion, { chunkChars: streamChunkChars }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}