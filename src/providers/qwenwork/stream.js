// vendor 自 _shared/sse.js 的 transform（真流式：上游 SSE → OpenAI chunk，边收边吐）。
// 唯一一处**有意偏离**原作者实现：把 chunk 里的 `model` 回写成客户端请求的模型名。
// 上游实际返回的是池名（实测 `qwork-openai-chat-mode-pool`），直接透传会让客户端按模型名匹配失败，
// 违反本仓契约 1「model 原样透传」。原作者的非流式路径同样做了 `completion.model = wantModel`。
import { handleLine } from "./sse.js";

function rewriteModel(frameText, model) {
  if (!model) return frameText;
  const body = frameText.slice(6, -2);
  let obj;
  try {
    obj = JSON.parse(body);
  } catch {
    return frameText;
  }
  if (!obj || typeof obj !== "object") return frameText;
  obj.model = model;
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export function transformStream(upstreamBody, model, onUsage, { heartbeatMs = 15000 } = {}) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let notified = false;
  let heartbeat = null;
  const state = { usage: null, error: null };

  const notify = () => {
    if (notified) return;
    notified = true;
    if (onUsage) onUsage(state.usage);
  };

  const emitError = (controller, message) => {
    try {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message, type: "upstream_error" } })}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    } catch {
      /* 客户端已断开 */
    }
  };

  const stopHeartbeat = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  const finish = () => {
    stopHeartbeat();
    notify();
  };

  return new ReadableStream({
    start(controller) {
      if (heartbeatMs > 0) {
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            /* 已关闭 */
          }
        }, heartbeatMs);
        if (heartbeat.unref) heartbeat.unref();
      }
    },
    async pull(controller) {
      try {
        for (;;) {
          let read;
          try {
            read = await reader.read();
          } catch (err) {
            const message = `upstream stream read error: ${err && err.message ? err.message : err}`;
            stopHeartbeat();
            emitError(controller, message);
            notify();
            return;
          }
          if (read.done) {
            stopHeartbeat();
            if (buffer) {
              const out = handleLine(buffer, state);
              if (out) controller.enqueue(encoder.encode(rewriteModel(out, model)));
              buffer = "";
            }
            if (state.error) emitError(controller, state.error);
            else {
              try {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
              } catch {
                /* 客户端已断开 */
              }
            }
            finish();
            return;
          }
          buffer += decoder.decode(read.value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          let out = "";
          for (const line of lines) {
            const frame = handleLine(line, state);
            if (frame) out += rewriteModel(frame, model);
          }
          if (out) {
            controller.enqueue(encoder.encode(out));
            return;
          }
        }
      } catch (err) {
        finish();
        try {
          emitError(controller, `stream error: ${err && err.message ? err.message : err}`);
        } catch {
          /* 已关闭 */
        }
      }
    },
    cancel(reason) {
      finish();
      if (reader.cancel) reader.cancel(reason);
    },
  });
}
