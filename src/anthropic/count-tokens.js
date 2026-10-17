// /v1/messages/count_tokens 的 token 估算（从 translate.js 拆出，控单文件体积 ≤20KB 硬门）。
// 精度非目标：Anthropic 官方说明该端点缺失时客户端本来就退回字符估算。
// 权重口径的单一来源在 ../text-tokens.js（ADR-0055）：旧版整段 `chars/4` 把中文低报约 4 倍，而客户端
// 正是拿这个读数决定何时压实上下文 —— 读数偏低就一路不压实，撞上游「上下文超限」才炸。
import { toolResultTextOf } from "./translate.js";
import { estimateTextTokens, createTokenCounter } from "../text-tokens.js";

// 图片不吃字符但占真实上下文，按固定面值计；总长设硬上限防极端请求把估算推到天文数字
const IMAGE_TOKENS = 2000;
const CHAR_CAP = 32_000_000;

// 请求侧按「一条消息」聚成一段再套一次公式：粒度对齐参照实现 wb_proxy.py:14267-14278
// （每条消息 content 整段一次 + 每个 tool_call 一次）。逐块各套会把「非空至少 1」下限乘上块数
// —— 几十个 1 字符 text 块能被高报几十倍（评审 P3：方向虽偏高安全，但与生成侧口径分叉就是第二个真相源）。
function add(acc, text) {
  // 超限后停止累计（chars 与 tokens 一起停）：只护 chars 会让 tokens 无界增长，
  // 客户端拿这个读数决定何时压实上下文 ⇒ 超长请求触发一次毫无必要的激进压缩。
  if (acc.chars > CHAR_CAP) return;
  const s = text == null ? "" : String(text);
  const c = createTokenCounter();
  c.add(s);
  acc.chars += s.length;
  acc.tokens += c.tokens();
}

function countMessage(m, acc) {
  if (!m || typeof m !== "object") return;
  const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : null;
  if (!blocks) { add(acc, JSON.stringify(m.content ?? "")); return; }
  const c = createTokenCounter();
  let chars = 0;
  const put = (s) => { c.add(s); chars += s.length; };
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (typeof b.text === "string") put(b.text);
    else if (b.type === "tool_use") put(String(b.name || "") + JSON.stringify(b.input ?? {}));
    else if (b.type === "tool_result") put(toolResultTextOf(b.content)); // 工具结果是大头，必须算
    else if (b.type === "thinking") put(String(b.thinking || ""));
    else if (b.type === "image") acc.images += 1;
  }
  // tokens 与 chars 必须**同受 CHAR_CAP 约束**：只护 chars 不护 tokens 时，超长请求（readBody 无大小上限，
  // 实测 10 条 4000 万字符消息 → 1.11 亿 tokens）会把读数推到天文数字，而客户端正是拿它决定何时压实上下文
  // ⇒ 一次毫无必要的激进压缩。超限后不再累加，保留已计部分。
  if (acc.chars <= CHAR_CAP) {
    acc.chars += chars;
    acc.tokens += c.tokens();
  }
}

/** 字符估算版 token 计数（Anthropic 官方：端点缺失时客户端本来就退回字符估算，精度非目标）。 */
export function estimateTokens(req = {}) {
  const acc = { chars: 0, tokens: 0, images: 0 };
  const sys = typeof req.system === "string" ? [{ type: "text", text: req.system }] : Array.isArray(req.system) ? req.system : [];
  for (const b of sys) add(acc, b && typeof b.text === "string" ? b.text : "");
  for (const m of Array.isArray(req.messages) ? req.messages : []) countMessage(m, acc);
  if (Array.isArray(req.tools)) add(acc, JSON.stringify(req.tools));
  // 字段名以 Anthropic 线上为准：`POST /v1/messages/count_tokens` 回 `{"input_tokens": N}`；
  // 额外带一份 count_tokens 仅作人读兼容（Claude Code 读的是 input_tokens）。
  const n = Math.max(1, acc.tokens) + acc.images * IMAGE_TOKENS;
  return { input_tokens: n, count_tokens: n };
}
