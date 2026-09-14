// workbuddy 上游对 tool 序列严格校验（400 code 11148 tool_call_sequence_broken）：
// assistant.tool_calls 与后续 tool 结果必须按 id 一一配对，否则整单拒绝并提示开新会话。
// 历史上下文经压缩/编辑/跨模型切换后可能断裂（有调用无结果、结果孤立、id 漂移），
// AI SDK 转换层对缺失字段用占位（toolName "tool" / toolCallId ""）进一步错配。
// 这里在 workbuddy 出口做防御性清洗：仅保留能成对出现的调用与结果，避免整单 400。
// 其他上游（opencode 等）宽容，不受影响——只挂在 workbuddy 链路。
export function sanitizeToolSequence(messages) {
  const list = Array.isArray(messages) ? messages : [];

  const callIds = new Set();
  for (const m of list) {
    if (m?.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const id = String(tc?.id || "");
        if (id) callIds.add(id);
      }
    }
  }

  const resultIds = new Set();
  for (const m of list) {
    if (m?.role === "tool") {
      const id = String(m.tool_call_id || "");
      if (id) resultIds.add(id);
    }
  }

  const paired = new Set();
  for (const id of callIds) if (resultIds.has(id)) paired.add(id);

  let droppedCalls = 0;
  let droppedResults = 0;
  const out = [];
  for (const m of list) {
    if (m?.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const kept = m.tool_calls.filter((tc) => paired.has(String(tc?.id || "")));
      droppedCalls += m.tool_calls.length - kept.length;
      if (kept.length) {
        out.push({ ...m, tool_calls: kept });
      } else if (typeof m.content === "string" && m.content) {
        const { tool_calls: _dropped, ...rest } = m;
        out.push(rest);
      }
      continue;
    }
    if (m?.role === "tool") {
      if (paired.has(String(m.tool_call_id || ""))) out.push(m);
      else droppedResults++;
      continue;
    }
    out.push(m);
  }

  return { messages: out, droppedCalls, droppedResults };
}
