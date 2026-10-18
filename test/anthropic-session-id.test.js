// Claude 系会话身份提取（对齐 cc-switch session.rs:107-231）：
// Claude Code 把会话 id 放在请求体 metadata 里，只读 header 会漏 → 上游每轮换缓存 key。
import test from "node:test";
import assert from "node:assert/strict";
import { claudeSessionId } from "../src/anthropic/session-id.js";

const jwtish = (sessionId) => JSON.stringify({ device_id: "d1", session_id: sessionId });

test("session-id：header 优先（x-claude-code-session-id，再 claude-code-session-id）", () => {
  assert.deepEqual(
    claudeSessionId({ "x-claude-code-session-id": "hdr-1" }, { metadata: { session_id: "meta-1" } }),
    { sessionId: "hdr-1", source: "header" },
  );
  assert.deepEqual(claudeSessionId({ "claude-code-session-id": "hdr-2" }, null), { sessionId: "hdr-2", source: "header" });
});

test("session-id：metadata.user_id 的 JSON session_id（Claude Code 现网形态）", () => {
  assert.deepEqual(claudeSessionId({}, { metadata: { user_id: jwtish("ba6c16ed6a89") } }), { sessionId: "ba6c16ed6a89", source: "metadata.user_id" });
  // 坏 JSON / 空值 / 非字符串：不猜，落到下一档
  assert.equal(claudeSessionId({}, { metadata: { user_id: "{坏", session_id: "" } }), null);
  assert.equal(claudeSessionId({}, { metadata: { user_id: JSON.stringify({ session_id: "   " }) } }), null);
  assert.equal(claudeSessionId({}, { metadata: { user_id: 123 } }), null);
});

test("session-id：metadata.user_id 的旧 `_session_` 后缀格式", () => {
  assert.deepEqual(
    claudeSessionId({}, { metadata: { user_id: "user_abc_session_5f2d" } }),
    { sessionId: "5f2d", source: "metadata.user_id" },
  );
  assert.equal(claudeSessionId({}, { metadata: { user_id: "user_abc" } }), null);
});

test("session-id：metadata.session_id 兜底；全缺返回 null（不生成会变的值）", () => {
  assert.deepEqual(claudeSessionId({}, { metadata: { session_id: " meta-3 " } }), { sessionId: "meta-3", source: "metadata.session_id" });
  assert.equal(claudeSessionId({}, {}), null);
  assert.equal(claudeSessionId({}, { metadata: null }), null);
  assert.equal(claudeSessionId({}, { previous_response_id: "resp_each_turn_changes" }), null);
});
