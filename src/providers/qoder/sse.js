// qoder 上游 SSE 信封解析（转译 qoder2api bridge.go ExtractDelta）
// 帧形态：data:{"headers":{},"body":"<内层JSON>","statusCodeValue":200}
// 信封 statusCodeValue!=200 = 瞬时上游错；内层 code!=0 = 业务错；usage 同帧合并
// 排障日志（QODER_DEBUG_STREAM=1 开）：静默吞帧的分支必须有痕，否则"内容凭空消失"无从追
const DBG_SSE = () => process.env.QODER_DEBUG_STREAM === "1";
const ddbg = (...a) => { if (DBG_SSE()) console.log("[qoder-sse]", ...a); };

export function extractDelta(dataLine) {
  let wrapper;
  try { wrapper = JSON.parse(dataLine); } catch (e) {
    ddbg(`[envelope-parse-fail] ${e.message} line=${dataLine.slice(0, 300)}`);
    return {};
  }
  if (wrapper.statusCodeValue !== undefined && Number(wrapper.statusCodeValue) !== 200) {
    const detail = typeof wrapper.body === "string" && wrapper.body ? wrapper.body : JSON.stringify(wrapper).slice(0, 400);
    return { err: { kind: "upstream", status: Number(wrapper.statusCodeValue) || 502, detail } };
  }
  const inner = wrapper.body;
  if (!inner || typeof inner !== "string") {
    ddbg(`[body-not-string] bodyType=${typeof inner} envelopeKeys=${Object.keys(wrapper).join(",")} envelope=${dataLine.slice(0, 300)}`);
    return {};
  }
  let j;
  try { j = JSON.parse(inner); } catch (e) {
    ddbg(`[inner-parse-fail] ${e.message} body=${inner.slice(0, 300)}`);
    return {};
  }
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
  // 走到这里 = 帧既无 content/tool_calls、也无业务错、也无 usage。空轮排查的关键取证点：
  // 把内层 JSON 的顶层键与 choices 原样打出来，一眼看出上游改了什么字段名。
  ddbg(`[no-delta] innerKeys=${Object.keys(j).join(",")} choicesLen=${choices.length} inner=${JSON.stringify(j).slice(0, 400)}`);
  return {};
}

// 错误四分类 → HTTP 状态（对齐 errors.go ErrorStatus 语义）
export function errorStatus(err) {
  if (!err) return 500;
  if (err.kind === "content_policy") return 400;
  if (err.kind === "auth") return [401, 403].includes(err.status) ? err.status : 401;
  if (err.kind === "upstream") return [401, 403, 429].includes(err.status) ? err.status : 502;
  return 502;
}
