import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWorkbuddyHeaders, buildWorkbuddyConfigHeaders } from "../src/providers/workbuddy/client-headers.js";

const AUTH = { uid: "uid-1", domain: "www.codebuddy.cn", enterpriseId: "" };

// 活体 2026-10-21 证实的 id 生成器硬约束：
//  - chat: X-Request-ID 家族 = UUIDv7 去横线（第 13 位 '7'、第 17 位 8/9/a/b、前 12 位=当前毫秒）；
//    X-Conversation-ID 家族 = UUIDv4 带横线（版本位 4、变体位 8~b）。
//  - config: X-Request-ID = 去横线 UUIDv4（真机 b1f4cb939a57486d86d16b74bec13511 第13位='4'第17位='8'）。
const V7_HEX = /^[0-9a-f]{8}[0-9a-f]{4}7[0-9a-f]{3}[89ab][0-9a-f]{3}[0-9a-f]{12}$/;
const V4_DASH = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const V4_HEX = /^[0-9a-f]{8}[0-9a-f]{4}4[0-9a-f]{3}[89ab][0-9a-f]{3}[0-9a-f]{12}$/;
// chat 请求头键集快照（CLI trace_start_hook @4733511 + buildConversationHeaders @5997642 +
// getCustomHeaders 身份头全集，逐项对齐活体/ bundle，改动需对证据）
const CHAT_KEYS = [
  "Accept", "Accept-Encoding", "Authorization", "Content-Type", "User-Agent", "X-Agent-Intent",
  "X-Agent-Purpose", "X-Agent-Type", "X-B3-Sampled", "X-B3-SpanId", "X-B3-TraceId", "X-Conversation-ID",
  "X-Conversation-Message-ID", "X-Conversation-Request-ID", "X-Domain", "X-IDE-Name", "X-IDE-Type",
  "X-IDE-Version", "X-Private-Data", "X-Product", "X-Request-ID", "X-Session-ID", "X-Trace-ID", "X-User-Id",
  "acp-connection-id", "b3", "x-codebuddy-request", "x-requested-with",
];

test("client-headers: 官方桌面端口径全集（chat 带会话/trace，无 Origin/Referer）", () => {
  const h = buildWorkbuddyHeaders("tok", AUTH);
  assert.equal(h["Authorization"], "Bearer tok");
  assert.equal(h["X-User-Id"], "uid-1");
  assert.equal(h["X-Domain"], "www.codebuddy.cn");
  assert.equal(h["X-Product"], "SaaS");
  assert.match(h["User-Agent"], /^WorkBuddy\/[\d.]+ WorkBuddy\/[\d.]+ CLI\/[\d.]+$/);
  assert.equal(h["X-IDE-Type"], "WorkBuddy");
  assert.equal(h["X-IDE-Name"], "WorkBuddy");
  assert.equal(h["X-Agent-Type"], "main");
  assert.equal(h["X-Private-Data"], "false", "真值=优化默认开→false（CLI bundle getCustomHeaders @3669309：c[PRIVATE_DATA_HEADER]=h?\"false\":\"true\"）");
  assert.equal(h["x-codebuddy-request"], "1");
  assert.equal(h["x-requested-with"], "XMLHttpRequest");
  assert.equal(h["X-Agent-Intent"], "craft");
  assert.equal(h["X-Agent-Purpose"], "conversation");
  assert.equal(h["Accept"], "application/json");
  // 真机 chat 转发排除 origin，我们不得再带
  assert.equal(h["Origin"], undefined);
  assert.equal(h["Referer"], undefined);
  // 会话/追踪 id 存在且每请求唯一
  for (const k of ["X-Conversation-ID", "X-Conversation-Request-ID", "X-Conversation-Message-ID", "X-Request-ID", "X-Trace-ID"]) {
    assert.ok(h[k], `missing ${k}`);
  }
  // id 生成器形状（风控画像硬约束，裸 hex 版本位 15/16 概率错、时间戳乱码一眼假）
  assert.match(h["X-Request-ID"], V7_HEX, "X-Request-ID 必须 UUIDv7 去横线");
  assert.match(h["X-Conversation-ID"], V4_DASH, "X-Conversation-ID 必须 UUIDv4 带横线");
  assert.match(h["acp-connection-id"], V7_HEX, "acp-connection-id 同 v7 形");
  // v7 时间戳前缀≈当前毫秒（±5s）
  const ts = Number.parseInt(h["X-Request-ID"].slice(0, 12), 16);
  assert.ok(Math.abs(Date.now() - ts) < 5000, `v7 时间戳应≈当前毫秒，偏差 ${Math.abs(Date.now() - ts)}ms`);
  const h2 = buildWorkbuddyHeaders("tok", AUTH);
  assert.notEqual(h["X-Conversation-ID"], h2["X-Conversation-ID"], "会话 id 每请求随机");
  assert.notEqual(h["X-Request-ID"], h2["X-Request-ID"], "请求 id 每请求随机");
  // 会话双头同值；message=request 同值；Conversation-Request-ID 是**另一个** v7（bundle @5997642：
  // message/request 用同一 i，conversationRequestId 用 x8w(turn 级生成器)——两值各一）
  assert.equal(h["X-Session-ID"], h["X-Conversation-ID"]);
  assert.equal(h["X-Conversation-Message-ID"], h["X-Request-ID"]);
  assert.match(h["X-Conversation-Request-ID"], V7_HEX, "Conversation-Request-ID 也是 v7");
  assert.notEqual(h["X-Conversation-Request-ID"], h["X-Request-ID"], "turn 级与 message 级各生成一份 v7");
  // ⚠ 条件头：X-Root-Request-ID / X-Parent-Conversation-ID 真机仅 sub-agent/续聊轮才带
  //（bundle resolveRootRequestId/resolveParentConversationId：meta 有值才设）。
  // 网关一调用=新会话首请求，带上=把每条请求伪造成续聊，画像反常 → 必须不带。
  assert.equal(h["X-Root-Request-ID"], undefined, "首请求不带 Root 头");
  assert.equal(h["X-Parent-Conversation-ID"], undefined, "首请求不带 Parent 头");
  // CLI trace 形（@4733511）：无 traceparent/ParentSpanId；b3 三段
  assert.equal(h["traceparent"], undefined, "CLI 链路不发 traceparent（那是 Electron 转发链形状）");
  assert.equal(h["X-B3-ParentSpanId"], undefined);
  assert.match(h["b3"], /^[0-9a-f]{32}-[0-9a-f]{16}-1$/);
  assert.equal(h["X-B3-TraceId"], h["X-Trace-ID"]);
  // 键集快照：多发一个少发一个都算画像漂移
  assert.deepEqual(Object.keys(h).sort(), CHAT_KEYS, "chat 头键集必须与真机一致");
});

test("client-headers: 无会话端点（config/refresh）不带 conversation/trace 头", () => {
  const h = buildWorkbuddyHeaders("tok", AUTH, { withConversation: false });
  assert.equal(h["X-Conversation-ID"], undefined);
  assert.equal(h["traceparent"], undefined);
  assert.equal(h["X-IDE-Type"], "WorkBuddy"); // 身份头仍在
});

test("client-headers: config 6 头集 + X-Request-ID=去横线 UUIDv4（活体 b1f4cb93… 第13位'4'第17位'8'）", () => {
  const h = buildWorkbuddyConfigHeaders("tok", AUTH);
  assert.deepEqual(Object.keys(h).sort(), ["Authorization", "User-Agent", "X-Domain", "X-Product", "X-Request-ID", "X-User-Id"]);
  assert.match(h["X-Request-ID"], V4_HEX, "config id 必须 v4 去横线（非 v7、非裸 hex）");
  assert.equal(h["Content-Type"], undefined, "GET 不带 Content-Type");
});

test("client-headers: enterprise 号带 X-Enterprise-Id/X-Tenant-Id", () => {
  const h = buildWorkbuddyHeaders("tok", { uid: "u", domain: "www.codebuddy.cn", enterpriseId: "ent-9" });
  assert.equal(h["X-Enterprise-Id"], "ent-9");
  assert.equal(h["X-Tenant-Id"], "ent-9");
});

test("client-headers: MSLXDFF_WORKBUDDY_LEGACY_HEADERS=1 一键回退旧口径", () => {
  process.env.MSLXDFF_WORKBUDDY_LEGACY_HEADERS = "1";
  try {
    const h = buildWorkbuddyHeaders("tok", AUTH);
    assert.equal(h["User-Agent"], "CLI/2.115.0 WorkBuddy/2.115.0");
    assert.equal(h["Origin"], "https://www.codebuddy.cn");
    assert.equal(h["X-IDE-Type"], undefined);
    assert.equal(h["Accept"], "application/json");
  } finally {
    delete process.env.MSLXDFF_WORKBUDDY_LEGACY_HEADERS;
  }
});

test("client-headers: 版本可由 env 覆盖（客户端升级跟改）", () => {
  process.env.MSLXDFF_WORKBUDDY_APP_VERSION = "9.9.9";
  process.env.MSLXDFF_WORKBUDDY_CLI_VERSION = "2.161.0";
  try {
    const h = buildWorkbuddyHeaders("tok", AUTH);
    assert.equal(h["X-IDE-Version"], "9.9.9");
    assert.equal(h["User-Agent"], "WorkBuddy/9.9.9 WorkBuddy/9.9.9 CLI/2.161.0");
  } finally {
    delete process.env.MSLXDFF_WORKBUDDY_APP_VERSION;
    delete process.env.MSLXDFF_WORKBUDDY_CLI_VERSION;
  }
});
