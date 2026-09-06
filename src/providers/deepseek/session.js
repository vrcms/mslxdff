// DeepSeek 会话：无痕模式（每次 completion 前建、后删）
import { androidHeaders, netRetry } from "./pow.js";
import { DEEPSEEK_API_PREFIX } from "./pow.js";
import { dsDebug, dsDump, dsError } from "./debug.js";

export async function createChatSession({ token, fetchImpl, dispatcher, baseUrl = "https://chat.deepseek.com", connectTimeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("DeepSeek 会话创建超时")), connectTimeoutMs);
  let res;
  try {
    res = await netRetry(() => fetchImpl(`${String(baseUrl).replace(/\/+$/, "")}${DEEPSEEK_API_PREFIX}/chat_session/create`, {
      method: "POST",
      headers: androidHeaders(token),
      body: JSON.stringify({ agent: "chat" }),
      ...(dispatcher ? { dispatcher } : {}),
      signal: controller.signal,
    }), { attempts: 2, delayMs: 400 });
  } catch (err) {
    dsError("session", err);
    throw new Error(`DeepSeek 会话创建失败: ${String(err?.message || err)}`);
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = await res.json(); } catch {}
  dsDebug("session", { event: "create", status: res.status, bizCode: data?.data?.biz_code });
  if (data?.data?.biz_code !== 0) dsDump("session", "create body", JSON.stringify(data), 800);
  // 新版协议（x-client-version 2.0.0）id 在 biz_data.chat_session.id；旧版在 biz_data.id
  const id = data?.data?.biz_data?.chat_session?.id ?? data?.data?.biz_data?.id;
  if (!res.ok || data?.data?.biz_code !== 0 || !id) {
    const msg = data?.data?.biz_msg || data?.msg || "响应缺少会话 id";
    const err = new Error(`DeepSeek 会话创建失败: ${msg}${res.ok ? "" : ` (http ${res.status})`}`);
    // 401/403 = 凭据被拒：带 status 供上层 rotateAuth（与 completion 阶段 classifyFailure 对齐）
    if (res.status === 401 || res.status === 403) err.status = res.status;
    throw err;
  }
  return id;
}

export async function deleteChatSession({ token, sessionId, fetchImpl, dispatcher, baseUrl = "https://chat.deepseek.com", connectTimeoutMs = 15_000 } = {}) {
  // 收尾动作：任何失败都静默（不抛），避免污染主流程
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), connectTimeoutMs);
    try {
      await fetchImpl(`${String(baseUrl).replace(/\/+$/, "")}${DEEPSEEK_API_PREFIX}/chat_session/delete`, {
        method: "POST",
        headers: androidHeaders(token),
        body: JSON.stringify({ chat_session_id: sessionId }),
        ...(dispatcher ? { dispatcher } : {}),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {}
}

// 中止生成（官方协议：stop_stream 不需要 PoW header；message_id 取 ready 的 response_message_id）
// ds-free-api raw-api-reference §6
export async function stopDeepseekStream({ token, sessionId, messageId, fetchImpl, dispatcher, baseUrl = "https://chat.deepseek.com", connectTimeoutMs = 15_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("DeepSeek stop_stream 超时")), connectTimeoutMs);
  try {
    const res = await fetchImpl(`${String(baseUrl).replace(/\/+$/, "")}${DEEPSEEK_API_PREFIX}/chat/stop_stream`, {
      method: "POST",
      headers: androidHeaders(token),
      body: JSON.stringify({ chat_session_id: sessionId, message_id: messageId }),
      ...(dispatcher ? { dispatcher } : {}),
      signal: controller.signal,
    });
    dsDebug("session", { event: "stop_stream", sessionId, messageId, status: res.status });
    if (!res.ok) dsDump("session", `stop_stream non-ok http=${res.status}`, await res.text().catch(() => ""), 400);
  } catch (err) {
    dsError("session", err);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// 从 SSE 流读 event:ready 的 response_message_id（跨块缓冲）
function parseReadyMessageId(buf) {
  const idx = buf.indexOf("event: ready");
  if (idx < 0) return null;
  const m = buf.slice(idx).match(/event: ready\s*\ndata: (\{[^\n]*\})/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[1]);
    return j?.response_message_id != null ? Number(j.response_message_id) : null;
  } catch { return null; }
}

// 分块喂养：等 ready 拿 message_id → 等 update_session（上游把消息落库的信号；真机实测
// ready 后立刻 stop，下一块 parent_message_id 会报 biz_code:26 invalid message id）
// → stop_stream 中止生成 → drain 上游到关。update_session 未出现（流已关）也继续，宽松兜底。
export async function feedChunkToSession({ res, token, sessionId, fetchImpl, dispatcher, baseUrl, connectTimeoutMs = 30_000 } = {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let messageId = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    if (messageId == null) messageId = parseReadyMessageId(buf);
    if (messageId != null && buf.includes("event: update_session")) break;
  }
  if (messageId == null) throw new Error("DeepSeek 分块喂养失败：ready 事件缺少 response_message_id");
  await stopDeepseekStream({ token, sessionId, messageId, fetchImpl, dispatcher, baseUrl, connectTimeoutMs });
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
  return messageId;
}
