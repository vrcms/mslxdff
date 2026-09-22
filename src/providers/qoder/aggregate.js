// qoder 非流式聚合：上游 SSE 全读完 → chat.completion JSON。
// 真流式走 stream.js；本模块只服务 stream:false（行为与旧 callQoder 聚合同）。
import { extractDelta } from "./sse.js";

export async function aggregateQoderStream(upstreamRes) {
  const reader = upstreamRes.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let usage = null;
  let content = "";
  let reasoning = "";
  const toolCalls = [];
  let sawContent = false;
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
      if (d.usageIn > 0 || d.usageOut > 0) {
        usage = { prompt_tokens: d.usageIn, completion_tokens: d.usageOut, total_tokens: d.usageIn + d.usageOut };
      }
      if (d.content) { content += d.content; sawContent = true; }
      if (d.reasoning) { reasoning += d.reasoning; sawContent = true; }
      if (d.toolCalls) { toolCalls.push(...d.toolCalls); sawContent = true; }
    }
    if (done) break;
  }
  if (!sawContent && !usage) throw { kind: "upstream", status: 502, detail: "empty upstream stream" };
  return { usage, content, reasoning, toolCalls };
}

export function toCompletionJson({ model, chatId, content, reasoning, toolCalls, usage }) {
  const msg = { role: "assistant", content: content || (toolCalls.length ? null : "") };
  if (reasoning) msg.reasoning_content = reasoning;
  if (toolCalls.length) msg.tool_calls = toolCalls;
  return {
    id: chatId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: msg, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
