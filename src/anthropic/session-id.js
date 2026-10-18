/**
 * Claude 系会话身份提取 —— 1:1 照抄 cc-switch `src-tauri/src/proxy/session.rs:107-231`（Claude 分支）。
 *
 * 为什么需要：会话 id 用来给上游做「缓存亲和 / 粘性路由」（`prompt_cache_key`、会话头）。
 * cc-switch #8236 的教训是：拿不到真实会话身份就每轮生成一个新 id ⇒ 每轮换缓存 key ⇒
 * 前缀缓存永不命中。Claude Code 走 `/v1/messages` 时把会话身份放在**请求体 metadata**里
 * （不是 header），所以只读 header 的实现会一路漏。
 *
 * 优先级（与 cc-switch 一致）：
 *  1. header `x-claude-code-session-id`，再 `claude-code-session-id`（非空即用：**不 trim、无长度门槛**）
 *  2. `metadata.user_id`：trim 后以 `{` 开头 → 当 JSON 解析取 `session_id`（trim 后非空才认）；
 *     否则找字面量 `_session_`，取其后的整段（旧格式）
 *  3. `metadata.session_id`（字符串，trim 后非空）
 *  4. 都没有 → 返回 null（由调用方走既有兜底，绝不在这里凭空生成：生成值会每轮变）
 *
 * 明确不用（cc-switch 同款判断）：Responses 的 `previous_response_id` 之类「每轮变化的响应游标」
 * 不是稳定会话身份，当成缓存 key 会导致每轮换 key。
 */

const CLAUDE_SESSION_HEADERS = ["x-claude-code-session-id", "claude-code-session-id"];
const LEGACY_MARKER = "_session_";

/** `metadata.user_id` → 会话 id（JSON 里的 session_id，或旧 `_session_` 后缀）。 */
function sessionFromUserId(userId) {
  const t = typeof userId === "string" ? userId.trim() : "";
  if (!t) return null;
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t);
      const s = typeof j?.session_id === "string" ? j.session_id.trim() : "";
      return s || null;
    } catch {
      return null; // 坏 JSON：不猜，交下一档
    }
  }
  const i = t.indexOf(LEGACY_MARKER);
  if (i < 0) return null;
  return t.slice(i + LEGACY_MARKER.length) || null;
}

/**
 * @param {Record<string, unknown>} headers 入站头（Node 已小写化）
 * @param {any} body 原始 Anthropic 请求体
 * @returns {{sessionId: string, source: string} | null}
 */
export function claudeSessionId(headers = {}, body = null) {
  for (const name of CLAUDE_SESSION_HEADERS) {
    const v = headers?.[name];
    if (typeof v === "string" && v) return { sessionId: v, source: "header" };
  }
  const meta = body && typeof body === "object" && body.metadata && typeof body.metadata === "object" ? body.metadata : null;
  if (!meta) return null;
  const fromUser = sessionFromUserId(meta.user_id);
  if (fromUser) return { sessionId: fromUser, source: "metadata.user_id" };
  const sid = typeof meta.session_id === "string" ? meta.session_id.trim() : "";
  if (sid) return { sessionId: sid, source: "metadata.session_id" };
  return null;
}
