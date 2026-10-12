// /v1/messages/count_tokens 的字符估算（从 translate.js 拆出，控单文件体积 ≤20KB 硬门）。
// 精度非目标：Anthropic 官方说明该端点缺失时客户端本来就退回字符估算。
import { toolResultTextOf } from "./translate.js";

// 图片不吃字符但占真实上下文，按固定面值计；总长设硬上限防极端请求把除法推到 Infinity
const IMAGE_TOKENS = 2000;
const CHARS_PER_TOKEN = 4;
const CHAR_CAP = 32_000_000;

function countMessage(m, acc) {
  if (!m || typeof m !== "object") return;
  const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : null;
  if (!blocks) { acc.chars += JSON.stringify(m.content ?? "").length; return; }
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (typeof b.text === "string") acc.chars += b.text.length;
    else if (b.type === "tool_use") acc.chars += String(b.name || "").length + JSON.stringify(b.input ?? {}).length;
    else if (b.type === "tool_result") acc.chars += toolResultTextOf(b.content).length; // 工具结果是大头，必须算（grill Q7）
    else if (b.type === "thinking") acc.chars += String(b.thinking || "").length;
    else if (b.type === "image") acc.images += 1;
  }
}

/** 字符估算版 token 计数（Anthropic 官方：端点缺失时客户端本来就退回字符估算，精度非目标）。 */
export function estimateTokens(req = {}) {
  let chars = 0;
  let images = 0;
  const acc = { chars: 0, images: 0 };
  const sys = typeof req.system === "string" ? [{ type: "text", text: req.system }] : Array.isArray(req.system) ? req.system : [];
  for (const b of sys) acc.chars += b && typeof b.text === "string" ? b.text.length : 0;
  for (const m of Array.isArray(req.messages) ? req.messages : []) countMessage(m, acc);
  if (Array.isArray(req.tools)) acc.chars += JSON.stringify(req.tools).length;
  chars = Math.min(acc.chars, CHAR_CAP);
  images = acc.images;
  // 字段名以 Anthropic 线上为准：`POST /v1/messages/count_tokens` 回 `{"input_tokens": N}`；
  // 额外带一份 count_tokens 仅作人读兼容（Claude Code 读的是 input_tokens）。
  const n = Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS);
  return { input_tokens: n, count_tokens: n };
}
