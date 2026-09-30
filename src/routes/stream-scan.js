// relay 的观测累加器：把流式 SSE chunk / 非流式 JSON 体读成 detail 上的计数事实。
// 抽自 src/routes/stream.js（单文件 20KB 硬门，见 AGENTS.md「先拆后写」），行为与抽出前逐字一致。
// 纯函数契约：只读写传入的 detail，不碰 res / 定时器 / 闸门 / 网络，因此可离线单测。
// 语义钉子：detail.chars 只算正文，思考内容另计（reasoningChars）——两者相加会重复计数。
import { extractUsageFromJson } from "../metrics.js";

// 逐 SSE chunk 扫描：done/finish_reason/chat 形状/工具调用/usage/正文字符
export function scanSseChunk(detail, txt) {
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
