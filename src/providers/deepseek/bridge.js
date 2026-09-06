// DeepSeek bridge：OpenAI messages ↔ DeepSeek web 协议互转
// prompt 构造参考 iidamie/deepseek2api messages_prepare（协议事实）
// SSE 事件层（event/data 分块 + 流尾 flush）+ 调 sse-decoder.js 纯解码
import { createDeepseekDeltaParser } from "./sse-decoder.js";

const USER_TAG = "<｜User｜>";
const ASSISTANT_OPEN = "<｜Assistant｜>";
const ASSISTANT_CLOSE = "<｜end▁of▁sentence｜>";

export function buildPrompt(messages) {
  const list = (messages || []).map((m) => {
    let text = "";
    if (Array.isArray(m?.content)) {
      text = m.content
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n");
    } else if (m?.content != null) {
      text = String(m.content);
    }
    return { role: String(m?.role || ""), text };
  });
  if (!list.length) return "";

  const merged = [list[0]];
  for (const msg of list.slice(1)) {
    if (msg.role && msg.role === merged[merged.length - 1].role) {
      merged[merged.length - 1].text += `\n\n${msg.text}`;
    } else {
      merged.push(msg);
    }
  }

  const parts = [];
  for (let idx = 0; idx < merged.length; idx++) {
    const { role, text } = merged[idx];
    if (role === "assistant") {
      parts.push(`${ASSISTANT_OPEN}${text}${ASSISTANT_CLOSE}`);
    } else if (role === "user" || role === "system") {
      parts.push(idx > 0 ? `${USER_TAG}${text}` : text);
    } else {
      parts.push(text);
    }
  }
  return parts.join("");
}

// 输入字符上限（ds-free-api 实测标定：default/vision≈1M tokens；expert≈64K tokens 与官方 API 一致）
// 超限时上游 HTTP 200 + event:hint(input_exceeds_limit) + 立即 close；阈值取上限 75% 留余量
const INPUT_CHAR_LIMITS = { expert: 163_840, default: 2_621_440, vision: 2_621_440 };

export function promptThresholdFor(flags = {}) {
  const limit = flags?.expert ? INPUT_CHAR_LIMITS.expert : INPUT_CHAR_LIMITS.default;
  return Math.floor(limit * 0.75);
}

// 硬切（对齐 ds-free-api split_prompt_chunks：不感知标签边界，按字符数）
export function splitPromptChunks(prompt, chunkSize) {
  const s = String(prompt ?? "");
  if (!chunkSize || chunkSize <= 0) return s ? [s] : [];
  const chunks = [];
  for (let i = 0; i < s.length; i += chunkSize) chunks.push(s.slice(i, i + chunkSize));
  return chunks;
}

export function mapModelToFlags(modelId) {
  const id = String(modelId || "");
  // 官网「专家模式」：completion body 显式 model_type:"expert"（真机抓包，model_type 取值 default/chat/reasoner/vision/expert）
  return {
    thinking: id.includes("reasoner"),
    search: id.includes("search"),
    expert: id.includes("expert"),
  };
}

export function buildUpstreamBody({ sessionId, prompt, thinking, search, expert, parentMessageId = null }) {
  const body = {
    chat_session_id: sessionId,
    parent_message_id: parentMessageId ?? null,
    prompt: String(prompt ?? ""),
    ref_file_ids: [],
    thinking_enabled: !!thinking,
    search_enabled: !!search,
  };
  // 非 expert 不传 model_type（v2.0.0 实测缺省走 session 的 default；expert 模式显式声明）
  if (expert) body.model_type = "expert";
  return body;
}

// SSE 事件层：喂入文本（可跨块断行），产出标准 delta 事件数组。
// 上游形态（Android x-client-version 2.0.0 真机抓包）：
//   event: ready / update_session / title / close
//   data: {"v":{"response":{fragments:[{type,content}]}}}   → 快照（decoder 做 unseen 后缀去重）
//   data: {"p":"response/fragments/-1/content","o":"APPEND","v":"字"} → 定向增量
//   data: {"v":"字"}                                        → 裸值：沿用 currentKind
//   data: {"p":"response/status","o":"SET","v":"FINISHED"}  → 结束
// startKind：thinking 请求首个 THINK fragment 可能以空对象 {} 下发（无 type），靠请求方兜底
export function createDeepseekSseParser({ startKind = "content" } = {}) {
  let buffer = "";
  let closeSeen = false;
  const decoder = createDeepseekDeltaParser({ startKind });

  function processEventBlock(rawEvent, out) {
    let eventName = "";
    const dataLines = [];
    for (const line of rawEvent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("event:")) { eventName = trimmed.slice(6).trim(); continue; }
      if (trimmed.startsWith("data:")) dataLines.push(trimmed.slice(5).trim());
    }
    if (eventName === "close" && !closeSeen && !decoder._state.finished) {
      closeSeen = true;
      out.push({ finish: "stop" });
      return;
    }
    // 上游拒绝信号（真机抓包）：event: hint + {"type":"error","content":"内容超长，请删减后再试","finish_reason":"input_exceeds_limit"}
    // 后跟 event: close，HTTP 仍是 200 —— 不透传就是"成功但空回复"
    if (eventName === "hint") {
      for (const dataStr of dataLines) {
        let d = null;
        try { d = JSON.parse(dataStr); } catch {}
        if (d?.type === "error") {
          out.push({ error: String(d.content || "上游拒绝"), finishReason: d.finish_reason || null, clearResponse: d.clear_response === true });
          return;
        }
      }
      return;
    }
    for (const dataStr of dataLines) {
      if (!dataStr || dataStr === "[DONE]") continue;
      for (const delta of decoder.consume(dataStr)) {
        if (delta.kind === "finish") out.push({ finish: "stop" });
        else if (delta.kind === "reasoning") out.push({ reasoning: delta.text });
        else out.push({ content: delta.text });
      }
    }
  }

  return function parse(chunk) {
    buffer += String(chunk ?? "");
    const out = [];
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      processEventBlock(rawEvent, out);
    }
    // 流尾 flush：仅当剩余 buffer 以换行结尾（data 行已完整终止）才处理，
    // 半截 JSON 保持缓冲等待下一块；否则 FINISHED/close 等尾部事件会永久卡在 buffer
    if (buffer.endsWith("\n") && buffer.trim()) {
      const rest = buffer;
      buffer = "";
      processEventBlock(rest, out);
    }
    return out;
  };
}
