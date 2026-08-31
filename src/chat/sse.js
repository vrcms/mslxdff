/**
 * SSE 聚合深模块：把网关可能返回的 text/event-stream 聚合为单次 JSON 形状
 * 纯函数，便于单测；与 gateway.js 共享
 */
export function parseSse(text) {
  const lines = String(text || "").split(/\r?\n/);
  let content = "";
  const toolCallsMap = new Map();
  let model = "auto";
  let usage = null;
  let finishReason = "stop";
  let sseOk = false;

  for (const line of lines) {
    const t = String(line).trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload);
      sseOk = true;
      const ch = obj.choices?.[0];
      if (ch?.finish_reason) finishReason = ch.finish_reason;
      if (ch?.delta?.content) content += ch.delta.content;
      else if (ch?.delta?.reasoning_content) content += ch.delta.reasoning_content;
      else if (ch?.message?.content) content += ch.message.content;
      else if (ch?.message?.reasoning_content) content += ch.message.reasoning_content;
      else if (typeof ch?.text === "string") content += ch.text;
      else if (typeof obj.content === "string") content += obj.content;

      if (ch?.delta?.tool_calls) {
        for (const tc of ch.delta.tool_calls) {
          const idx = tc.index ?? 0;
          const cur = toolCallsMap.get(idx) || { id: tc.id || `chatcmpl-tool-${idx}`, type: tc.type || "function", function: { name: "", arguments: "" } };
          if (tc.id) cur.id = tc.id;
          if (tc.type) cur.type = tc.type;
          if (tc.function?.name) cur.function.name = tc.function.name;
          if (typeof tc.function?.arguments === "string") cur.function.arguments += tc.function.arguments;
          toolCallsMap.set(idx, cur);
        }
      }
      if (ch?.message?.tool_calls) {
        for (const tc of ch.message.tool_calls) {
          const idx = tc.index ?? toolCallsMap.size;
          toolCallsMap.set(idx, tc);
        }
      }
      if (obj.model) model = obj.model;
      if (obj.usage) usage = obj.usage;
      if (obj.choices?.[0]?.message?.content && !content) content = obj.choices[0].message.content;
      if (obj.choices?.[0]?.message?.reasoning_content && !content) content = obj.choices[0].message.reasoning_content;
      if (obj.choices?.[0]?.message?.tool_calls && toolCallsMap.size === 0) {
        for (const tc of obj.choices[0].message.tool_calls) toolCallsMap.set(tc.index ?? 0, tc);
      }
    } catch {}
  }

  const toolCalls = [...toolCallsMap.values()].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return { content, toolCalls, model, usage, finishReason, sseOk };
}

export function sseToMessage(parsed, { hasContent, hasToolCalls } = {}) {
  const hc = hasContent ?? !!parsed.content;
  const ht = hasToolCalls ?? parsed.toolCalls.length > 0;
  if (!parsed.sseOk || (!hc && !ht)) return null;
  const msg = { role: "assistant", content: parsed.content || "" };
  if (ht) msg.tool_calls = parsed.toolCalls;
  return msg;
}
