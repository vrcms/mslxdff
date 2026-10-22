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
    // 登录过期（code 105）与非 200 容器同层：先于额度/排队判，命中交门面走「刷新令牌→原地重发」，
    // 绝不可当普通 403 冷却换号（实测会把整池过期号轮一遍，每号还叠 3 次空转重试，白烧）。
    const login = findLoginSignal(wrapper);
    if (login) return { err: { kind: "auth", status: 401, detail: login.slice(0, 300), loginExpired: true } };
    // 额度耗尽可能裹在非 200 信封里，且实测是**多层嵌套**（外层 statusCodeValue:403 →
    // code:10605 → 内层 code:"110" / "Billing daily count exceeded"）。只看一层会把额度错
    // 当普通 403；显式扫各层信号才能可靠命中（排队 10605 无 110 信号，天然不误判）。
    const quota = findQuotaSignal(wrapper);
    if (quota) return { err: { kind: "quota", status: 429, detail: quota.slice(0, 300) } };
    // 排队与额度共用 10605 容器 → 判序必须「先额度、后排队」。命中排队只在既有 upstream 上挂旗标，
    // 不新增 kind：errorStatus 与流内 error 的 type 字段一律不变（对外契约零改动），
    // 门面据 x-mslxdff-qoder-queued 走队列档冷却 + 同请求换号。
    const queued = findQueueSignal(wrapper);
    if (queued) {
      const ra = retryAfterFrom(detail);
      return { err: { kind: "upstream", status: Number(wrapper.statusCodeValue) || 502, detail, queued: true, code: queued.code, ...(queued.noCapacity ? { noCapacity: true } : {}), ...ra } };
    }
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
  // 实测真身形态：statusCodeValue:200 信封，内层 body 直接 {"code":"105","message":"Login expired"}。
  // 只认内层结构化 code（正常 chat chunk 无顶层 code 字段，正文文本永不匹配 → 零误伤）。
  if (isLoginExpired(j.code, j.message)) return { err: { kind: "auth", status: 401, code: j.code, detail: String(j.message || "").slice(0, 300), loginExpired: true } };
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
    // 判序：内容审核文案最先——上游会把 inappropriate 类文案配在 1xx/4xx 码上（既有契约锁「审核→content_policy」）。
    if (/inappropriate|DataInspection|Sensitive|ContentFilter/i.test(msg)) return { err: { kind: "content_policy", code: j.code, detail: msg } };
    // 额度耗尽（官方额度码族 + Billing 专属措辞）：按配额错单列，门面据此换号（长冷却）。
    if (isQuotaError(j.code, msg)) return { err: { kind: "quota", status: 429, code: j.code, detail: msg || `code=${j.code}` } };
    // 请求被拒（内容/长度/能力，换号无用）：归 request → 400 直出，不冷却不换号。
    if (isRequestError(j.code)) return { err: { kind: "request", code: j.code, detail: msg || `code=${j.code}` } };
    return { err: { kind: "business", code: j.code, detail: msg } };
  }
  if (finishReason) return { finishReason, usageIn, usageOut };
  if (usageIn > 0 || usageOut > 0) return { usageIn, usageOut };
  // 走到这里 = 帧既无 content/tool_calls、也无业务错、也无 usage。空轮排查的关键取证点：
  // 把内层 JSON 的顶层键与 choices 原样打出来，一眼看出上游改了什么字段名。
  ddbg(`[no-delta] innerKeys=${Object.keys(j).join(",")} choicesLen=${choices.length} inner=${JSON.stringify(j).slice(0, 400)}`);
  return {};
}

/** 额度耗尽识别：Qoder 额度码家族（110、112–114、117–119、122）+ Billing 专属措辞。
 *  旧版只认 110——实测上游 403 信封内层发同族码时会被误归 business→502，
 *  门面按普通坏号短冷却 30s 反复撞（额度按天重置，短冷却等于白烧），故补全。
 *  收紧两处（均为实测冲突证据，宁缺勿滥）：
 *  - code 115（"quota exceeded" 泛化措辞）归业务错（既有契约：不误伤）；
 *  - code 116 官方表写 Team Credits，但现网实测被复用为 DataInspection 内容审核 → 不入额度族，留给 content_policy。 */
const QUOTA_CODES = new Set(["110", "112", "113", "114", "117", "118", "119", "122"]);
export function isQuotaError(code, message) {
  if (QUOTA_CODES.has(String(code || "").trim())) return true;
  return /billing\s*(daily)?\s*(count|limit|quota)?\s*exceed/i.test(String(message || ""));
}

// 请求拒绝码（对齐 magpie/CLIProxyAPI 的 REQUEST_CODES 真值）：这些是「这条请求被拒」而非「这个号不行」——
// 敏感内容(406)/范围不支持(416)/能力不支持(430)/输入过长(80411)/图太多(80412)/自定义模型服务侧(1004xx)。
// 换号救不了（同一条请求发给哪个号都被拒），故归 request → errorStatus 折 400 直出，不冷却不换号。
const REQUEST_CODES = new Set(["406", "416", "430", "80411", "80412", "100400", "100401", "100402", "100403"]);
export function isRequestError(code) {
  return REQUEST_CODES.has(String(code || "").trim());
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
 *  实测形态：403 信封 → code 10605 → message 里带 isQueued:true、retryAfterSeconds:30。
 *  noCapacity 子型（2026-10-22 现网）：isQueued:true + queueCount:0 + serviceAvailable:false + subCode:RESOURCE_LIMIT
 *  = 「p3 队列此刻无容量、无人在排」——同档位整池共享同一队列，换号救不了，只能等 Retry-After。
 *  2026-10-22 真机回归：现网 HTTP 403 body 是四层转义信封
 *  {"error":{"message":"{\"code\":\"403\",\"message\":\"{\\\"code\\\":\\\"10605\\\",…}}"}——
 *  引号被叠成 \"isQueued\"，带引号的正则在第 0 层永远打不中，纯靠下钻又撞深度顶。
 *  与 retryAfterFrom 同法：判决前先剥反斜杠归一，令任意嵌套层度的字面量都还原为可匹配形态。 */
export function isQueueSignal(code, message) {
  if (String(code || "").trim() === QUEUE_CODE) return true;
  const s = String(message || "").replace(/\\/g, "");
  if (!s) return false;
  return /"isQueued"\s*:\s*true/.test(s) || /"serviceAvailable"\s*:\s*false/.test(s);
}

// noCapacity 判据（isQueueSignal 已命中为前提）：队列空（queueCount:0）且服务不可用（serviceAvailable:false）。
// 与「真排队等放行」（queueCount>0）区分：前者换号无用（整池同队列同容量），后者可能另一号有空位。
// 剥反斜杠同 isQueueSignal（真机四层转义，见上）。
export function isNoCapacitySignal(message) {
  const s = String(message || "").replace(/\\/g, "");
  if (!s) return false;
  return /"queueCount"\s*:\s*0/.test(s) && /"serviceAvailable"\s*:\s*false/.test(s);
}

/** 排队信号扫描：与 findQuotaSignal 同构（同限深、字符串层自动 parse 下钻），命中返回 { code, noCapacity }。 */
export function findQueueSignal(value, depth = 0) {
  if (value == null || depth > MAX_ENVELOPE_DEPTH) return null;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;
    if (isQueueSignal("", s)) return { code: QUEUE_CODE, noCapacity: isNoCapacitySignal(s) };
    try {
      return findQueueSignal(JSON.parse(s), depth + 1);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object") return null;
  if (isQueueSignal(value.code, value.message)) {
    return { code: String(value.code || QUEUE_CODE), noCapacity: isNoCapacitySignal(String(value.message || "")) };
  }
  for (const v of Object.values(value)) {
    const hit = findQueueSignal(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// 登录过期（code 105 "Login expired"）：令牌过期≠号坏——官方 CLI 临期自动续，
// 识别命中后门面用 refresh_token 换新 token 原地重发；refresh 也被拒（真作废）才长冷却该号并提示重登。
export function isLoginExpired(code, message) {
  if (String(code || "").trim() === "105") return true;
  const s = String(message || "");
  // 只认带 code 的结构化形态（正文里出现 "Login expired" 字样不得误伤）。
  // (?![0-9]) 数字边界是 2026-10-22 真机教训：排队码 10605 以 105 开头，
  // 无边界时 "code":"10605" 被当前缀命中 → login 抢在 queue 判决前误判，noCapacity 链全哑。
  return /"code"\s*:\s*"?105"?(?![0-9])/.test(s);
}

/** 登录信号扫描：与 findQuotaSignal 同构（限深 4 层、字符串层自动 parse 下钻）。 */
export function findLoginSignal(value, depth = 0) {
  if (value == null || depth > MAX_ENVELOPE_DEPTH) return null;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;
    if (isLoginExpired("", s)) return s;
    try {
      return findLoginSignal(JSON.parse(s), depth + 1);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object") return null;
  if (isLoginExpired(value.code, value.message)) return String(value.message || "Login expired");
  for (const v of Object.values(value)) {
    const hit = findLoginSignal(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// 从错误 detail（可能是 JSON 或 JSON-in-string）里抽 retryAfterSeconds → { retryAfter: 秒 }（无则 {}）。
// 上游排队判决自带 retryAfterSeconds:30，透传给上层做 Retry-After，别让上层瞎猜退避。
export function retryAfterFrom(text) {
  const m = String(text || "").replace(/\\/g, "").match(/"retryAfterSeconds"\s*:\s*(\d+)/i);
  if (!m) return {};
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? { retryAfter: n } : {};
}

// 错误分类 → HTTP 状态（对齐 errors.go ErrorStatus 语义；request=请求被拒折 400 直出）
export function errorStatus(err) {
  if (!err) return 500;
  if (err.kind === "content_policy") return 400;
  if (err.kind === "request") return 400; // 换号无用：如实 400 给客户端，不冷却不换号
  if (err.kind === "auth") return [401, 403].includes(err.status) ? err.status : 401;
  if (err.kind === "upstream") return [401, 403, 429].includes(err.status) ? err.status : 502;
  if (err.kind === "quota") return 429; // 额度错按限流语义出（门面据此换号/冷却）
  return 502;
}
