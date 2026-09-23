// 请求消息序列诊断（纯函数）：上游 11148 tool_call_sequence_broken 时定位断裂点。
// 上游校验规则：assistant.tool_calls 必须与紧随其后的 tool 结果按 id 严格配对，
// 且配对过程不能被其他消息（user/assistant/system）打断——仅集合级 id 配对（sanitize-tools）不够。
// 在 SDK 错误路径对 AI SDK 实际发出的请求体做本诊断，异常位置用消息下标指认。
export function compactSequence(messages, from = 0, limit = Infinity) {
  const list = Array.isArray(messages) ? messages : [];
  const end = Number.isFinite(limit) ? Math.min(list.length, from + limit) : list.length;
  const out = [];
  for (let i = Math.max(0, from); i < end; i++) {
    const m = list[i] || {};
    const role = String(m.role || "?");
    if (role === "assistant") {
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      out.push(calls.length ? `A{${calls.map((t) => String(t?.id || "empty")).join(",")}}` : "A");
    } else if (role === "tool") out.push(`T{${String(m.tool_call_id || "empty")}}`);
    else if (role === "user") out.push("U");
    else if (role === "system" || role === "developer") out.push("S");
    else out.push(String(role)[0] || "?");
  }
  return out.join(" ");
}

export function diagnoseToolSequence(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const issues = [];
  const open = new Map();
  const seenResults = new Set();
  let calls = 0;
  let results = 0;
  const first = list[0];
  if (first && first.role !== "user" && first.role !== "system" && first.role !== "developer") {
    issues.push(`#0 首条为 ${String(first.role || "?")}（上游拒带工具链的 assistant/tool 开头）`);
  }
  list.forEach((m, i) => {
    const role = m?.role;
    if (role === "assistant") {
      const tcs = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      if (tcs.length) {
        if (open.size) issues.push(`#${i} assistant 打断未闭合{${[...open.keys()].join(",")}}`);
        for (const tc of tcs) {
          const id = String(tc?.id || "");
          calls++;
          if (!id) issues.push(`#${i} tool_call 空 id`);
          else if (open.has(id)) issues.push(`#${i} call id 重复:${id}`);
          else open.set(id, i);
        }
      } else if (open.size) {
        issues.push(`#${i} assistant(无调用) 打断{${[...open.keys()].join(",")}}`);
      }
    } else if (role === "tool") {
      results++;
      const id = String(m.tool_call_id || "");
      if (!id) issues.push(`#${i} tool 结果空 id`);
      else if (seenResults.has(id)) issues.push(`#${i} 结果重复:${id}（上游按 call_id 查重会 400 Duplicate function_call_output，去重后只应出现一次）`);
      else { seenResults.add(id); if (!open.has(id)) issues.push(`#${i} 孤立结果:${id}`); else open.delete(id); }
    } else if (open.size) {
      issues.push(`#${i} ${role} 打断{${[...open.keys()].join(",")}}`);
    }
  });
  for (const [id, at] of open) issues.push(`#${at} 悬空调用:${id}`);
  return { issues, summary: `msgs=${list.length} calls=${calls} results=${results}` };
}
