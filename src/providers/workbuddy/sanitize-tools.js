// workbuddy 上游对 tool 序列严格校验（400 code 11148 tool_call_sequence_broken），实测三条规则：
// ① assistant.tool_calls 与结果必须按 id 一一配对（孤立调用/结果均拒）；
// ② 结果必须紧跟对应 assistant（配对不能被 user/assistant 消息打断）；
// ③ 序列不能以"带 tool_calls 的 assistant"开头（tool call 无前置上下文即拒；compaction 裁剪点
//    落在工具链中间时最易触发）。
// 这里在 workbuddy 出口做防御性清洗：结果前移到对应调用之后（组内按 calls 顺序）、剔无法配对的
// 调用/结果、首条为 assistant/tool 时注入占位 user（"continue"）。其他上游宽容不受影响——只挂 workbuddy。
export function sanitizeToolSequence(messages) {
  const list = Array.isArray(messages) ? messages : [];

  const resultById = new Map();
  list.forEach((m, idx) => {
    if (m?.role !== "tool") return;
    const id = String(m.tool_call_id || "");
    if (id && !resultById.has(id)) resultById.set(id, { msg: m, idx, used: false });
  });

  let droppedCalls = 0;
  let droppedResults = 0;
  let movedResults = 0;
  const out = [];
  list.forEach((m, idx) => {
    if (m?.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const kept = [];
      for (const tc of m.tool_calls) {
        const r = resultById.get(String(tc?.id || ""));
        if (r && !r.used) kept.push(tc);
        else droppedCalls++;
      }
      if (kept.length) {
        out.push({ ...m, tool_calls: kept });
        for (const tc of kept) {
          const r = resultById.get(String(tc.id));
          r.used = true;
          if (!(r.idx >= idx + 1 && r.idx <= idx + kept.length)) movedResults++;
          out.push(r.msg);
        }
      } else if (typeof m.content === "string" && m.content) {
        const { tool_calls: _dropped, ...rest } = m;
        out.push(rest);
      }
      return;
    }
    if (m?.role === "tool") {
      const id = String(m.tool_call_id || "");
      const r = resultById.get(id);
      if (r && r.idx === idx && r.used) return; // 已前移消费，跳过原位置
      droppedResults++; // 孤儿或重复
      return;
    }
    out.push(m);
  });

  let injectedHead = 0;
  if (out.length && out[0]?.role !== "user" && out[0]?.role !== "system" && out[0]?.role !== "developer") {
    out.unshift({ role: "user", content: "continue" });
    injectedHead = 1;
  }

  return { messages: out, droppedCalls, droppedResults, movedResults, injectedHead };
}
