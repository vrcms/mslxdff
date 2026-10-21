// WorkBuddy 出站请求头——照抄本机官方桌面端 5.8.3 的组装真值（buildVlmGatewayHeaders +
// applyGatewayHeaders + applyTraceHeaders 三函数，逆向自 app.asar @89622109，见 .scratch/wb-chat-headers.txt）。
// 为什么要它：2026-10-21 三号集体撞 `403 11140 账号存在异常行为` 封号，且换 UA 到官方完整口径也照样 11140
//   ——判的是账号本体，但旧出站指纹是**自造杂交串**：UA `CLI/2.115.0 WorkBuddy/2.115.0`（真机是
//   `WorkBuddy/5.8.3 WorkBuddy/5.8.3`）、缺 X-IDE-*/X-Private-Data/x-codebuddy-request/X-Conversation-*/
//   traceparent 全链追踪头、还多带真机 chat 明确排除的 Origin/Referer。裸指纹 + 桌面登录号 = 风控画像。
//   对齐口径降低「登新号又被带进沟」的概率。⚠ 对齐是降风险非保命，封号是账号级、refresh 已证实无效。
// 版本随客户端自动更新会漂移：MSLXDFF_WORKBUDDY_APP_VERSION 覆盖（缺省 5.8.3）；
//   MSLXDFF_WORKBUDDY_CLI_VERSION 非空才追加 ` CLI/<v>` 段（真机 buildVlmGatewayHeaders 的 i 参数可为空）。
// 一键回退旧口径：MSLXDFF_WORKBUDDY_LEGACY_HEADERS=1。
import { randomBytes } from "node:crypto";

const APP_VERSION = () => (process.env.MSLXDFF_WORKBUDDY_APP_VERSION || "5.8.3").trim();
// CLI 段版本取自本机活体日志（a06ef5f8 实时 chat 请求 UA `WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0`）。
const CLI_VERSION = () => {
  const v = (process.env.MSLXDFF_WORKBUDDY_CLI_VERSION ?? "").trim();
  return v === "" ? "2.161.0" : v; // 缺省跟本机真值；显式空串仍可关掉该段
};
const isLegacy = () => process.env.MSLXDFF_WORKBUDDY_LEGACY_HEADERS === "1";

function hex(n) { return randomBytes(n).toString("hex"); }

// 真机 X-Request-ID 家族是 UUIDv7（毫秒时间戳打头 48bit + 版本位 7 + 变体位 10xx），
// 活体日志证实：`01a15dcaf9a97a86a215ac50f6bcdfff` 第 13 位恒为 '7'。裸 hex 版本位 15/16 概率错、
// 时间戳前缀是乱码——风控一眼假。按 https://www.rfc-editor.org/rfc/rfc9562 组真 v7。
function uuidv7hex() {
  const b = Buffer.from(randomBytes(16));
  const ts = Date.now();
  b[0] = Math.floor(ts / 2 ** 40) & 0xff;
  b[1] = Math.floor(ts / 2 ** 32) & 0xff;
  b[2] = Math.floor(ts / 2 ** 24) & 0xff;
  b[3] = Math.floor(ts / 2 ** 16) & 0xff;
  b[4] = Math.floor(ts / 2 ** 8) & 0xff;
  b[5] = ts & 0xff;
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  return b.toString("hex");
}
// 真机 X-Conversation-ID 家族是 UUIDv4（带横线，版本位 4 / 变体位 8~b），活体：`b84c6a36-bd21-461a-b9be-…`。
function uuidv4dashed() {
  const b = Buffer.from(randomBytes(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// 真机 CLI trace 头（bundle @4733511 trace_start_hook，**不是** Electron 代理链的 applyTraceHeaders）：
// 只设 X-Trace-ID/X-B3-TraceId(=同 traceId 32hex)/X-B3-SpanId(16hex)/X-B3-Sampled=1/b3(<trace32>-<span16>-1 三段)。
// 无 traceparent、无 X-B3-ParentSpanId——那两个是 Electron web 转发链的形状，chat 实发者是 CLI 子进程，别抄错链路。
function traceHeaders() {
  const n = hex(16), r = hex(8);
  return {
    "X-Trace-ID": n,
    "X-B3-TraceId": n,
    "X-B3-SpanId": r,
    "X-B3-Sampled": "1",
    b3: `${n}-${r}-1`,
  };
}

// 网关态：每次调用是一条新逻辑会话。id 形状取自活体日志（2026-10-21 a06ef5f8 正常发 200 的 CLI 请求）：
// 会话 id = **UUIDv4 带横线**（`b84c6a36-bd21-461a-b9be-…`）；请求 id = **UUIDv7 去横线**（第 13 位恒 '7'）。
// bundle 逐字（@5997642 buildConversationHeaders）：X-Conversation-ID=会话 id；X-Request-ID=X-Conversation-Message-ID
// =同一 uuidv7 双写；X-Conversation-Request-ID=**另一个** uuidv7（turn 级生成器）。网关一调用=新会话=新 turn，
// 两值各生成一份即可（真机一 turn 多请求时才复用 Conversation-Request-ID）。
// ⚠ X-Root-Request-ID / X-Parent-Conversation-ID 真机是**条件头**（meta 有值才设——sub-agent/续聊轮才带）。
//   网关永远首请求，带上=把每条请求伪造成续聊，画像反常 → 不带。X-Session-ID 保留（活体 config/日志有同值头）。
function conversationHeaders() {
  const conv = uuidv4dashed();
  const req = uuidv7hex();
  const turn = uuidv7hex();
  return {
    "X-Conversation-ID": conv,
    "X-Session-ID": conv,
    "X-Request-ID": req,
    "X-Conversation-Request-ID": turn,
    "X-Conversation-Message-ID": req,
    "X-Agent-Type": "main",
    "acp-connection-id": req,
  };
}

function legacyHeaders(key, auth, accept) {
  const h = {
    "Content-Type": "application/json",
    Accept: accept,
    "User-Agent": "CLI/2.115.0 WorkBuddy/2.115.0",
    Origin: "https://www.codebuddy.cn",
    Referer: "https://www.codebuddy.cn/",
    "X-Product": "SaaS",
  };
  if (key) h["Authorization"] = `Bearer ${key}`;
  if (auth?.uid) h["X-User-Id"] = auth.uid;
  h["X-Domain"] = auth?.domain || "www.codebuddy.cn";
  if (auth?.enterpriseId) { h["X-Enterprise-Id"] = auth.enterpriseId; h["X-Tenant-Id"] = auth.enterpriseId; }
  return h;
}

// 官方桌面端完整口径。三处出口（chat / refresh / config）共用，保证**一个号一张脸**：
//   chat 带每请求 conversation/trace id；refresh、config 无会话 → withConversation:false。
//   真机 buildVlmGatewayHeaders 的 Accept 是 application/json（SSE 靠 body.stream 协商），故 accept 默认即此。
export function buildWorkbuddyHeaders(key, auth, { accept = "application/json", withConversation = true } = {}) {
  if (isLegacy()) return legacyHeaders(key, auth, accept);
  const app = APP_VERSION(), cli = CLI_VERSION();
  const ua = [`WorkBuddy/${app}`, `WorkBuddy/${app}`, ...(cli ? [`CLI/${cli}`] : [])].join(" ");
  const h = {
    "Content-Type": "application/json",
    Accept: accept,
    "Accept-Encoding": "identity",
    "User-Agent": ua,
    "X-IDE-Type": "WorkBuddy",
    "X-IDE-Name": "WorkBuddy",
    "X-IDE-Version": app,
    "X-Private-Data": process.env.MSLXDFF_WORKBUDDY_PRIVATE_DATA || "false",
    "X-Product": "SaaS",
    "x-requested-with": "XMLHttpRequest",
    "x-codebuddy-request": "1",
    "X-Agent-Intent": "craft",
    "X-Agent-Purpose": "conversation",
    ...(withConversation ? conversationHeaders() : {}),
    ...(withConversation ? traceHeaders() : {}),
  };
  if (key) h["Authorization"] = `Bearer ${key}`;
  if (auth?.uid) h["X-User-Id"] = auth.uid;
  h["X-Domain"] = auth?.domain || "www.codebuddy.cn";
  if (auth?.enterpriseId) { h["X-Enterprise-Id"] = auth.enterpriseId; h["X-Tenant-Id"] = auth.enterpriseId; }
  return h;
}

// GET /v3/config 专用：活体真值＝本机 CLI 子进程（好号 a06ef5f8 正常工作中）2026-10-21 17:29 实发的 6 头集
//（客户端日志逐字：authorization/user-agent(WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0)/x-domain/x-product/x-request-id/x-user-id）。
// ⚠ config 的 x-request-id=`b1f4cb939a57486d86d16b74bec13511` 第13位='4'、第17位='8' → 是**去横线 UUIDv4**，
//   与 chat 的 UUIDv7 生成器不同（两条链路各自的 id 策略）。**无 Content-Type（GET）、无 X-IDE-*、无 trace、无 Origin/Referer**——
//   别拿 chat 全量头套它（2026-10-21 曾 over-align，按活体回退）。
export function buildWorkbuddyConfigHeaders(key, auth) {
  const app = APP_VERSION(), cli = CLI_VERSION();
  const ua = [`WorkBuddy/${app}`, `WorkBuddy/${app}`, ...(cli ? [`CLI/${cli}`] : [])].join(" ");
  const h = {
    "User-Agent": ua,
    "X-Domain": auth?.domain || "www.codebuddy.cn",
    "X-Product": "SaaS",
    "X-Request-ID": uuidv4dashed().replace(/-/g, ""),
  };
  if (key) h["Authorization"] = `Bearer ${key}`;
  if (auth?.uid) h["X-User-Id"] = auth.uid;
  return h;
}
