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
    // 额度耗尽可能裹在非 200 信封里，且实测是**多层嵌套**（外层 statusCodeValue:403 →
    // code:10605 → 内层 code:"110" / "Billing daily count exceeded"）。只看一层会把额度错
    // 当普通 403；显式扫各层信号才能可靠命中（排队 10605 无 110 信号，天然不误判）。
    const quota = findQuotaSignal(wrapper);
    if (quota) return { err: { kind: "quota", status: 429, detail: quota.slice(0, 300) } };
    // 排队与额度共用 10605 容器 → 判序必须「先额度、后排队」。命中排队只在既有 upstream 上挂旗标，
    // 不新增 kind：errorStatus 与流内 error 的 type 字段一律不变（对外契约零改动），
    // 门面据 x-mslxdff-qoder-queued 走队列档冷却 + 同请求换号。
    const queued = findQueueSignal(wrapper);
    return { err: { kind: "upstream", status: Number(wrapper.statusCodeValue) || 502, detail, ...(queued ? { queued: true, code: queued.code } : {}) } };
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
  let finishReason = "";
  for (const ch of choices) {
    const fr = ch?.finish_reason;
    if (typeof fr === "string" && fr) finishReason = fr;
    const delta = ch?.delta;
    if (!delta) continue;
    const role = typeof delta.role === "string" ? delta.role : "";
    const content = typeof delta.content === "string" ? delta.content : "";
    const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
    const toolCalls = Array.isArray(delta.tool_calls) && delta.tool_calls.length ? delta.tool_calls : null;
    if (role || content || reasoning || toolCalls) {
      return { role, content, reasoning, toolCalls, usageIn, usageOut, ...(finishReason ? { finishReason } : {}) };
    }
  }
  if (typeof j.code === "string" && j.code && j.code !== "0") {
    const msg = String(j.message || "");
    // 额度耗尽（实测 code=110 "Billing daily count exceeded"）：按配额错单列，门面据此换号。
    // 只认 code 110 / Billing 专属措辞 —— 普通 "quota exceeded"（code 115）仍归业务错，不误伤。
    if (isQuotaError(j.code, msg)) return { err: { kind: "quota", status: 429, code: j.code, detail: msg || `code=${j.code}` } };
    return { err: { kind: /inappropriate|DataInspection|Sensitive|ContentFilter/i.test(msg) ? "content_policy" : "business", code: j.code, detail: msg } };
  }
  if (finishReason) return { finishReason, usageIn, usageOut };
  if (usageIn > 0 || usageOut > 0) return { usageIn, usageOut };
  // 走到这里 = 帧既无 content/tool_calls、也无业务错、也无 usage。空轮排查的关键取证点：
  // 把内层 JSON 的顶层键与 choices 原样打出来，一眼看出上游改了什么字段名。
  ddbg(`[no-delta] innerKeys=${Object.keys(j).join(",")} choicesLen=${choices.length} inner=${JSON.stringify(j).slice(0, 400)}`);
  return {};
}

/** 额度耗尽识别：code 110 白名单 + Billing 专属措辞（收紧：普通 quota exceeded 归业务错） */
export function isQuotaError(code, message) {
  if (String(code || "").trim() === "110") return true;
  return /billing\s*(daily)?\s*(count|limit|quota)?\s*exceed/i.test(String(message || ""));
}

// 显式额度信号扫描：信封各层里找 code 110 / Billing 明确措辞。
// 限深 4 层（实测 3 层足够，留一层余量），字符串层自动尝试 JSON.parse 后继续下钻。
// 排队 10605（isQueued/serviceAvailable）无 110 信号 → 返回 null，天然不误判为额度。
// 排队容器码（实测与额度错共用同一容器：外层 403 → code 10605 → 内层才分额度/排队）
const QUEUE_CODE = "10605";
const MAX_ENVELOPE_DEPTH = 4;
export function findQuotaSignal(value, depth = 0) {
  if (value == null || depth > MAX_ENVELOPE_DEPTH) return null;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;
    if (isQuotaError("", s)) return s;
    try {
      return findQuotaSignal(JSON.parse(s), depth + 1);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object") return null;
  if (isQuotaError(value.code, value.message)) return String(value.message || value.code || "");
  for (const v of Object.values(value)) {
    const hit = findQuotaSignal(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** 排队识别（与额度共用 10605 容器 → 判序必须先额度、后排队的纯函数）：
 *  命中条件 = 容器码 10605，或内层显式 isQueued:true / serviceAvailable:false。
 *  实测形态：403 信封 → code 10605 → message 里带 isQueued:true、retryAfterSeconds:30。 */
export function isQueueSignal(code, message) {
  if (String(code || "").trim() === QUEUE_CODE) return true;
  const s = String(message || "");
  if (!s) return false;
  return /"isQueued"\s*:\s*true/.test(s) || /"serviceAvailable"\s*:\s*false/.test(s);
}

/** 排队信号扫描：与 findQuotaSignal 同构（同限深、字符串层自动 parse 下钻），命中返回 { code }。 */
export function findQueueSignal(value, depth = 0) {
  if (value == null || depth > MAX_ENVELOPE_DEPTH) return null;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;
    if (isQueueSignal("", s)) return { code: QUEUE_CODE };
    try {
      return findQueueSignal(JSON.parse(s), depth + 1);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object") return null;
  if (isQueueSignal(value.code, value.message)) return { code: String(value.code || QUEUE_CODE) };
  for (const v of Object.values(value)) {
    const hit = findQueueSignal(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// 错误四分类 → HTTP 状态（对齐 errors.go ErrorStatus 语义）
export function errorStatus(err) {
  if (!err) return 500;
  if (err.kind === "content_policy") return 400;
  if (err.kind === "auth") return [401, 403].includes(err.status) ? err.status : 401;
  if (err.kind === "upstream") return [401, 403, 429].includes(err.status) ? err.status : 502;
  if (err.kind === "quota") return 429; // 额度错按限流语义出（门面据此换号/冷却）
  return 502;
}
