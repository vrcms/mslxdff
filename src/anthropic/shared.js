// /v1/messages 外壳的公共原语：消息/工具 id 与 Anthropic 协议错误体。
// ADR-0055 把请求侧拆去 request-body.js 时独立成档，让 request-body.js 与 translate.js 单向依赖它，
// 避免两文件互相 import 成环（函数提升虽能跑，顶层常量会 TDZ，属定时炸弹）。
// 共用面：src/anthropic/request-body.js（newToolUseId）、src/anthropic/translate.js（newMessageId/
// newToolUseId，并对外 re-export 三个符号，调用方与测试的 import 路径不变）。

let seq = 0;
export function newMessageId() {
  return `msg_${Date.now().toString(36)}${(seq++).toString(36)}`;
}
export function newToolUseId() {
  return `toolu_${Date.now().toString(36)}${(seq++).toString(36)}`;
}

/** Anthropic 协议错误体形状（非流式 JSON 与流式 in-band error 帧共用）。 */
export function anthropicError(type, message) {
  return { type: "error", error: { type: String(type || "api_error"), message: String(message || "error").slice(0, 500) } };
}
