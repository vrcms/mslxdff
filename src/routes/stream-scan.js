// relay 的观测累加器：把流式 SSE chunk / 非流式 JSON 体读成 detail 上的计数事实。
// 抽自 src/routes/stream.js（单文件 20KB 硬门，见 AGENTS.md「先拆后写」），行为与抽出前逐字一致。
// 纯函数契约：只读写传入的 detail，不碰 res / 定时器 / 闸门 / 网络，因此可离线单测。
// 语义钉子：detail.chars 只算正文，思考内容另计（reasoningChars）——两者相加会重复计数。
import { extractUsageFromJson } from "../metrics.js";

// 环形对话日志（talk log）的正文捕获：只有 relay 建了 detail.talk 才累积，未开启时零开销。
// 口径与 chars/reasoningChars 同源（读 delta，不读聚合帧），区别是这里存原文而不是只计数。
// 同样的边界：SSE 帧被 chunk 切断时该帧内容丢失（JSON.parse 失败即跳过）—— 研究用途可接受。
const TALK_CAP_CHARS = 400_000;

function talkPush(talk, dst, v) {
  if (typeof v !== "string" || !v) return;
  if (talk.n >= TALK_CAP_CHARS) { talk.capped = true; return; }
  talk.n += v.length;
  talk[dst].push(v);
}

// 流式 tool_calls 是分片到达的（index 定位、arguments 逐段拼），按 index 合回完整调用才看得懂。
function talkMergeToolCalls(talk, tcs) {
  for (const tc of tcs) {
    const i = Number.isInteger(tc?.index) ? tc.index : talk.tools.length;
    let slot = talk.tools[i];
    if (!slot) { slot = { id: "", type: "function", function: { name: "", arguments: "" } }; talk.tools[i] = slot; }
    if (tc.id) slot.id = tc.id;
    const nm = tc.function?.name;
    const ar = tc.function?.arguments;
    if (typeof nm === "string" && nm && !slot.function.name.includes(nm)) slot.function.name += nm;
    if (typeof ar === "string" && ar) slot.function.arguments += ar;
  }
}

/** 新建累积桶（n/capped 防超长生成把内存吃穿）。 */
export function createTalkBucket() { return { reasoning: [], content: [], tools: [], n: 0, capped: false }; }

/** 逐 chunk 累积一轮对话的思考/正文/工具调用。talk 为空 = 未开启，直接返回。 */
export function captureTalkSse(talk, txt) {
  if (!talk) return;
  for (const raw of String(txt ?? "").split("\n")) {
    const t = raw.trim();
    if (!t.startsWith("data:")) continue;
    const d = t.slice(5).trim();
    if (!d || d === "[DONE]") continue;
    let j = null;
    try { j = JSON.parse(d); } catch { continue; }
    const c0 = Array.isArray(j?.choices) ? j.choices[0] : null;
    if (!c0) continue;
    for (const src of [c0.delta, c0.message]) {
      if (!src) continue;
      talkPush(talk, "reasoning", src.reasoning_content ?? src.reasoning);
      talkPush(talk, "content", src.content);
      if (Array.isArray(src.tool_calls)) talkMergeToolCalls(talk, src.tool_calls);
    }
  }
}

/** 非流式：整块 message 直接入桶（tool_calls 参数本来就是完整的）。 */
export function captureTalkMessage(talk, msg) {
  if (!talk || !msg) return;
  talkPush(talk, "reasoning", msg.reasoning_content ?? msg.reasoning);
  talkPush(talk, "content", msg.content);
  if (Array.isArray(msg.tool_calls)) talkMergeToolCalls(talk, msg.tool_calls);
}

/** 透传兜底：无 chat 帧可解析（纯文本/未知形状）时把原文当正文收下，别让对话日志留空洞。 */
export function captureTalkFallback(talk, text) {
  if (!talk || !text) return;
  if (talk.reasoning.length || talk.content.length || talk.tools.length) return;
  if (String(text).includes('"choices"')) return;
  talkPush(talk, "content", String(text));
}

// 逐 SSE chunk 扫描：done/finish_reason/chat 形状/工具调用/usage/正文字符
export function scanSseChunk(detail, txt) {
  if (detail.talk) captureTalkSse(detail.talk, txt);
  try {
    if (txt.includes("[DONE]")) detail.sawDone = true;
    const m = txt.match(/"finish_reason"\s*:\s*"([^"]+)"/);
    if (m) detail.sawFinishReason = m[1];
    // chat 形状证据：只有看得出是 chat 轮才配判空（非 chat SSE/JSON 透传是正式契约，不得误伤）
    if (!detail.chatShaped && (txt.includes('"choices"') || txt.includes('"delta"') || txt.includes('"finish_reason"') || txt.includes('"usage"') || txt.includes('"prompt_tokens"') || txt.includes("[DONE]"))) detail.chatShaped = true;
    // 工具调用计数（空数组不算）：tool_calls 无正文是合法 agent 轮，
    // 空转闸门必须豁免它，否则所有工具轮都会被误判为空轮——见 relay-pipeline 4b。
    const tc = txt.match(/"tool_calls"\s*:\s*\[\s*\{/g);
    if (tc) detail.toolCalls = (detail.toolCalls || 0) + tc.length;
    // 尝试提取 usage（流式末帧）：口径收口到 metrics.js，与未流式分支共用
    if (txt.includes("\"usage\"") || txt.includes("\"prompt_tokens\"")) {
      try {
        const lines = txt.split("\n");
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const d = t.slice(5).trim();
          if (d === "[DONE]" || !d) continue;
          // 行级隔离：单行坏 JSON 不拖累同 chunk 其余行
          try {
            const j = JSON.parse(d);
            if (!j || typeof j !== "object") continue;
            const u = extractUsageFromJson(j);
            if (u) detail.usage = u;
            // 兜底 chars：从 choices 文本长度累加
            const delta = j.choices?.[0]?.delta?.content || j.choices?.[0]?.message?.content || "";
            if (delta) detail.chars += String(delta).length;
            const rc = j.choices?.[0]?.delta?.reasoning_content || j.choices?.[0]?.delta?.reasoning
              || j.choices?.[0]?.message?.reasoning_content || j.choices?.[0]?.message?.reasoning || "";
            if (rc) detail.reasoningChars = (detail.reasoningChars || 0) + String(rc).length;
          } catch { /* 单行坏帧忽略 */ }
        }
      } catch {}
    } else {
      // 非 usage 的普通 delta 也累 chars
      try {
        const ms = txt.match(/"content"\s*:\s*"([^"]*)"/g);
        if (ms) for (const mm of ms) {
          const c = JSON.parse(`{${mm}}`);
          if (c.content) detail.chars += String(c.content).length;
        }
        // 同一 chunk 里的思考增量：键名两种上游都见过（reasoning_content / reasoning）
        const rs = txt.match(/"reasoning(?:_content)?"\s*:\s*"([^"]*)"/g);
        if (rs) for (const mm of rs) {
          const c = JSON.parse(`{${mm}}`);
          const v = c.reasoning_content ?? c.reasoning;
          if (v) detail.reasoningChars = (detail.reasoningChars || 0) + String(v).length;
        }
      } catch {}
    }
  } catch { /* ignore */ }
}

// 非流式聚合 JSON 体：同源口径提 usage/chars/chat 形状/工具调用
export function scanNonStreamBody(detail, parsed) {
  const u = extractUsageFromJson(parsed);
  if (u) detail.usage = u;
  if (parsed.choices?.[0]?.message?.content) detail.chars = String(parsed.choices[0].message.content).length;
  else if (parsed.choices?.[0]?.text) detail.chars = String(parsed.choices[0].text).length;
  // 思考内容另记（qoder 的 stream:false 出口把思考放在 message.reasoning_content）
  const rc = parsed.choices?.[0]?.message?.reasoning_content || parsed.choices?.[0]?.message?.reasoning || "";
  if (rc) detail.reasoningChars = (detail.reasoningChars || 0) + String(rc).length;
  // 非流式同样只判 chat 形状：无 choices 的任意 JSON 是透传契约（chat-route 单测锁死），不得判空
  if (Array.isArray(parsed?.choices)) detail.chatShaped = true;
  const _tcList = parsed.choices?.[0]?.message?.tool_calls;
  if (Array.isArray(_tcList) && _tcList.length) detail.toolCalls = _tcList.length;
  if (detail.talk) captureTalkMessage(detail.talk, parsed.choices?.[0]?.message || (parsed.choices?.[0]?.text ? { content: parsed.choices[0].text } : null));
}

// 上报锚点偏移：转发入口时刻 − 本次上游尝试起点（performance.now 同源）。
// 只服务上报时长（usage 行），四类保护闸门仍用 relay 自己的 t0，绝不引用它。
export function preflightMs(t0, attemptStartMs) {
  // 锚点必须是与 t0 同源（performance.now）的有限 number；其余一律按「无锚点」降级为 0，
  // 宁可退回修复前口径，也不能产出 NaN 或假高值
  if (typeof attemptStartMs !== "number" || !Number.isFinite(attemptStartMs)) return 0;
  const delta = Math.round(t0 - attemptStartMs);
  return delta > 0 ? delta : 0;
}

/**
 * 空轮判据（纯函数，唯一真相）：看得 chat 形状 + 零正文 + 零工具调用 + 收尾不是工具轮。
 * stream.js 用它决定「这次要不要封口」，relay-pipeline 用它决定「交不交回重试」——两处不得各写一份。
 * chatShaped 是前置证据：非 chat SSE / 无 choices 的透传是正式契约，一律放行不判空。
 */
export function isEmptyTurnDetail(d) {
  if (!d || d.chatShaped !== true) return false;
  if ((Number(d.chars) || 0) > 0 || (Number(d.toolCalls) || 0) > 0) return false;
  if (["tool_calls", "function_call"].includes(d.sawFinishReason)) return false;
  return true;
}

// ===== 从 stream.js 迁入（体积门：stream.js 承载 relay 本体，纯判定函数一律住这里）=====

// 错误包络 chunk 判定（纯函数）：data 行 JSON 含顶层 .error 对象、或只有 finish_reason=error
// 的空帧，且整 chunk 无任何 content/tool_calls/reasoning 输出 → 返回错误摘要（建议暂扣），
// 否则返回 null（透传）。解析失败一律透传（默认保安全）。
// 背景：网关把上游失败包成 HTTP 200 SSE；暂扣后下游流式 UI 不再展示瞬时错误
//（如 Vertex 503 + google fallback 400），本轮走空转重试，客户端只看到最终结果。
// Note: 流内错误包络捕获与 retryAfterSeconds 错误直出 — 见 .agents/notes/implemented/bug-fix/2026-09-28-retry-after-surfacing-error.md
export function extractRetryAfterSec(obj) {
  if (!obj) return null;
  if (typeof obj === "number") return obj;
  if (typeof obj === "string") {
    const m = obj.match(/"retryAfterSeconds"\s*:\s*(\d+)/i) || obj.match(/\bretryAfterSeconds\s*[:=]\s*(\d+)/i);
    if (m) return Number(m[1]);
    try {
      const parsed = JSON.parse(obj);
      return extractRetryAfterSec(parsed);
    } catch {}
  }
  if (typeof obj === "object") {
    if (Number.isFinite(obj.retryAfterSeconds)) return Number(obj.retryAfterSeconds);
    if (obj.message) {
      const r = extractRetryAfterSec(obj.message);
      if (r != null) return r;
    }
  }
  return null;
}

export function holdableChunk(txt) {
  if (typeof txt !== "string" || !txt.includes("data:")) return null;
  let sawData = false;
  let sawEventError = false;
  let retrySec = null;
  const errs = [];
  for (const rawLine of txt.split("\n")) {
    const t = rawLine.trim();
    if (t.startsWith("event:") && t.slice(6).trim() === "error") {
      sawEventError = true;
      continue;
    }
    if (!t.startsWith("data:")) continue;
    const d = t.slice(5).trim();
    if (!d || d === "[DONE]") continue;
    let j = null;
    try { j = JSON.parse(d); } catch { return null; }
    if (!j || typeof j !== "object") return null;
    sawData = true;
    const c0 = (Array.isArray(j.choices) && j.choices[0]) || {};
    const delta = c0.delta || {};
    const msg = c0.message || {};
    const out = delta.content || msg.content || delta.tool_calls || msg.tool_calls || delta.reasoning || msg.reasoning;
    if (out && !(Array.isArray(out) && out.length === 0)) return null;

    const r = extractRetryAfterSec(j);
    if (r != null) {
      retrySec = r;
      continue;
    }
    if (j.error && typeof j.error === "object") {
      const m = j.error.message || j.error.code || "";
      if (m) errs.push(String(m).slice(0, 300));
    } else if (sawEventError && j.message) {
      errs.push(String(j.message).slice(0, 300));
    } else if (c0.finish_reason === "error") {
      errs.push("finish_reason=error 空帧");
    }
  }
  if (!sawData) return null;
  if (retrySec != null) return `上游供应商触发 retryAfterSeconds: ${retrySec} ，请等候重试`;
  if (errs.length) return errs.join(" | ");
  if (sawEventError) return "event: error 空帧";
  return null;
}

/**
 * 「可撤销前缀」判据（纯函数）：这个 chunk 里除空 delta 帧与 [DONE] 外不含任何信息吗？
 * 只有答案为是才允许暂扣不写——透传是正式契约：解析失败的帧、看不懂的形状一律立即透传（与
 * holdableChunk 同一口径：默认保安全，绝不因为想救空轮而扣掉本该原样转给客户端的字节）。
 */
export function isTrivialFrame(txt) {
  if (typeof txt !== "string" || !txt.includes("data:")) return false;
  let sawData = false;
  for (const rawLine of txt.split("\n")) {
    const t = rawLine.trim();
    if (!t.startsWith("data:")) continue;
    const d = t.slice(5).trim();
    if (!d) continue;
    if (d === "[DONE]") { sawData = true; continue; } // 结束符不含模型输出，可撤销
    let j = null;
    try { j = JSON.parse(d); } catch { return false; } // 解析失败 → 透传，绝不撤销
    if (!j || typeof j !== "object" || Array.isArray(j)) return false;
    // 白名单式可撤销：只认「choices 数组、且其中没有任何文本载荷」的 chat 帧。
    // 其余形状（choices[].text、delta.text、顶层 usage、无 choices 的自定义帧……）一律算有信息 → 透传。
    if (!Array.isArray(j.choices)) return false;
    sawData = true;
    if (j.choices.some((c) => c && typeof c === "object" && (c.text || c.message?.text))) return false;
    for (const c of j.choices) {
      if (!c || typeof c !== "object") return false;
      for (const src of [c.delta, c.message]) {
        if (!src || typeof src !== "object") continue;
        for (const [k, v] of Object.entries(src)) {
          if (k === "role" || k === "index" || k === "function_call_name") continue; // 无信息骨架字段
          if (v == null || v === "") continue;
          if (Array.isArray(v) ? v.length > 0 : true) return false; // 任何非空载荷都算产出
        }
      }
    }
  }
  return sawData;
}
