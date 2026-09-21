// qoder 上游 SSE 信封解析（转译 qoder2api bridge.go ExtractDelta）
// 帧形态：data:{"headers":{},"body":"<内层JSON>","statusCodeValue":200}
// 信封 statusCodeValue!=200 = 瞬时上游错；内层 code!=0 = 业务错；usage 同帧合并
export function extractDelta(dataLine) {
  let wrapper;
  try { wrapper = JSON.parse(dataLine); } catch { return {}; }
  if (wrapper.statusCodeValue !== undefined && Number(wrapper.statusCodeValue) !== 200) {
    const detail = typeof wrapper.body === "string" && wrapper.body ? wrapper.body : JSON.stringify(wrapper).slice(0, 400);
    return { err: { kind: "upstream", status: Number(wrapper.statusCodeValue) || 502, detail } };
  }
  const inner = wrapper.body;
  if (!inner || typeof inner !== "string") return {};
  let j;
  try { j = JSON.parse(inner); } catch { return {}; }
  let usageIn = 0, usageOut = 0;
  if (j.usage && typeof j.usage === "object") {
    usageIn = Math.trunc(Number(j.usage.prompt_tokens) || 0);
    usageOut = Math.trunc(Number(j.usage.completion_tokens) || 0);
  }
  const choices = Array.isArray(j.choices) ? j.choices : [];
  for (const ch of choices) {
    const delta = ch?.delta;
    if (!delta) continue;
    const role = typeof delta.role === "string" ? delta.role : "";
    const content = typeof delta.content === "string" ? delta.content : "";
    const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
    const toolCalls = Array.isArray(delta.tool_calls) && delta.tool_calls.length ? delta.tool_calls : null;
    if (role || content || reasoning || toolCalls) {
      return { role, content, reasoning, toolCalls, usageIn, usageOut };
    }
  }
  if (typeof j.code === "string" && j.code && j.code !== "0") {
    return { err: { kind: /inappropriate|DataInspection|Sensitive|ContentFilter/i.test(String(j.message)) ? "content_policy" : "business", code: j.code, detail: String(j.message || "") } };
  }
  if (usageIn > 0 || usageOut > 0) return { usageIn, usageOut };
  return {};
}

// 错误四分类 → HTTP 状态（对齐 errors.go ErrorStatus 语义）
export function errorStatus(err) {
  if (!err) return 500;
  if (err.kind === "content_policy") return 400;
  if (err.kind === "upstream") return [401, 403, 429].includes(err.status) ? err.status : 502;
  return 502;
}
