// 请求侧翻译：Anthropic Messages 请求体 → OpenAI chat 请求体（/v1/messages 外壳，ADR-0047）。
// 从 translate.js 拆出（ADR-0055）：translate.js 贴 20KB 体积硬门，且「入站请求形状」与
// 「出站响应/usage 翻译」本就是两向关注点，拆后 translate.js 单向 import 本文件，不回环。
// 对外接口不变：调用方与测试仍从 anthropic/translate.js import（那边 re-export）。
//
// 纪律（别改回去）：
//  * 思考档位**原样透传**（thinking/effort/reasoning_effort/reasoningEffort/extra_body），语义归一交给
//    各 provider 与 src/thinking-effort.js —— 旧版在此丢掉，下游被迫补默认值（workbuddy 恒 high，ADR-0053）；
//  * 但**必须主动丢** output_config 原始对象 / context_management / 消息块内 thinking：Claude Code 对
//    不认识的 model ID 照发全套字段，块内 thinking 无法签发 signature，回传必被上游拒（ADR-0047）。
import { isServerTool } from "./web-search.js";
import { newToolUseId } from "./shared.js";

// system 允许字符串或 text 块数组；块间空行连接（缓存语义不保留，上游是 OpenAI）
function systemTextOf(system) {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system.map((b) => (b && typeof b.text === "string" ? b.text : "")).filter(Boolean).join("\n\n");
}

function imagePartOf(block) {
  const src = block?.source || {};
  if (src.type === "base64" && src.data) {
    return { type: "image_url", image_url: { url: `data:${src.media_type || "image/png"};base64,${src.data}` } };
  }
  if (src.type === "url" && src.url) return { type: "image_url", image_url: { url: String(src.url) } };
  return null;
}

export function toolResultTextOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : p && typeof p.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return content == null ? "" : String(content);
}

/** Anthropic Messages 请求体 → OpenAI chat 请求体（直接喂既有 ChatPipeline）。 */
export function messagesToChatBody(req = {}) {
  const model = String(req.model || "").trim();
  if (!model) throw new Error("messages: 缺少 model");
  const messages = [];
  const sys = systemTextOf(req.system);
  if (sys) messages.push({ role: "system", content: sys });

  // 重复 tool_use_id 保首个、丢后续：客户端重试/重放历史会把同一工具结果存两份，
  // 部分上游按 call_id 查重直接 400（同 responses/translate.js:57-59 的实测教训）。
  const seenToolResult = new Set();

  for (const m of Array.isArray(req.messages) ? req.messages : []) {
    if (!m || typeof m !== "object") continue;
    // role=system/developer 必须保留：Claude Code ≥2.1.286 的 mid-conversation system beta 就往 messages[] 里塞系统指令，
    const role = m.role === "assistant" ? "assistant" : m.role === "system" || m.role === "developer" ? "system" : "user";
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
    let text = "";
    const imgs = [];
    const toolCalls = [];
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text") text += typeof b.text === "string" ? b.text : "";
      else if (b.type === "image") { const p = imagePartOf(b); if (p) imgs.push(p); }
      else if (b.type === "tool_use") {
        let args = "{}";
        try { args = JSON.stringify(b.input ?? {}); } catch { args = "{}"; }
        toolCalls.push({ id: String(b.id || newToolUseId()), type: "function", function: { name: String(b.name || ""), arguments: args } });
      } else if (b.type === "tool_result") {
        // tool 消息必须先于同轮 user 文本进数组：OpenAI 侧要求 role:tool 紧跟其 assistant
        const key = String(b.tool_use_id || "");
        if (key) { if (seenToolResult.has(key)) continue; seenToolResult.add(key); }
        const body = toolResultTextOf(b.content);
        messages.push({ role: "tool", tool_call_id: key, content: b.is_error ? `[tool_error] ${body}` : body });
      }
      // thinking / redacted_thinking 忽略：我们无法签发 signature，回传必被上游拒（ADR-0047）
    }
    if (!text && !imgs.length && !toolCalls.length) continue;
    const msg = { role, content: imgs.length ? [...(text ? [{ type: "text", text }] : []), ...imgs] : text };
    if (toolCalls.length) msg.tool_calls = toolCalls;
    messages.push(msg);
  }
  // 空会话直接 400：绝不伪造一句 "hi" 打上游（那会把假提问写进用户上下文并白烧一发额度）
  if (!messages.some((x) => x.role !== "system")) throw new Error("messages: 缺少用户消息");

  const body = { model, messages, stream: Boolean(req.stream) };
  // 流式必须让上游把 usage 放进收尾帧，否则 message_delta.usage 恒 0（OpenAI 规范字段）。
  // 个别上游不认 stream_options 会 400 → `MSLXDFF_ANTHROPIC_STREAM_USAGE=0` 关掉。
  if (body.stream && process.env.MSLXDFF_ANTHROPIC_STREAM_USAGE !== "0") body.stream_options = { include_usage: true };
  // Anthropic 的 server tool（web_search_*/web_fetch_*/…）没有 input_schema，折成假 function 会
  // 让上游收到「空参数空描述」的工具（严格端点直接 422），本网关不实现的发前一律剥除（ADR-0049）。
  const fnTools = (Array.isArray(req.tools) ? req.tools : []).filter((t) => !isServerTool(t));
  if (fnTools.length) {
    body.tools = fnTools.map((t) => ({
      type: "function",
      function: { name: String(t?.name || ""), description: String(t?.description || ""), parameters: t?.input_schema || {} },
    }));
  }
  const keptNames = new Set(fnTools.map((t) => String(t?.name || "")));
  const tc = req.tool_choice;
  if (tc === "auto" || (tc && typeof tc === "object" && tc.type === "auto")) body.tool_choice = "auto";
  else if (tc && typeof tc === "object" && tc.type === "any") body.tool_choice = "required";
  // 点名一个已被剥掉的工具时降为 auto：上游会按不存在的函数强制点名，那样一定拿不到有用回答
  else if (tc && typeof tc === "object" && tc.type === "tool") body.tool_choice = keptNames.has(String(tc.name || "")) ? { type: "function", function: { name: String(tc.name || "") } } : "auto";
  else if (tc && typeof tc === "object" && tc.type === "none") body.tool_choice = "none";
  if (req.max_tokens != null && Number.isFinite(Number(req.max_tokens))) body.max_tokens = Number(req.max_tokens);
  if (req.temperature != null) body.temperature = req.temperature;
  if (req.top_p != null) body.top_p = req.top_p;
  if (Array.isArray(req.stop_sequences) && req.stop_sequences.length) body.stop = req.stop_sequences;
  // 思考档位原样透传（不解释语义，语义归一交给各 provider / src/thinking-effort.js）：
  // 客户端显式声明必须一路带到上游，旧版在此丢掉 → 下游被迫补默认值（workbuddy 恒 high）。
  if (req.thinking != null) body.thinking = req.thinking;
  // 档位载体只收「非空 trimmed 字符串」：空串声明不算声明，不该发出去顶掉下游默认值。
  for (const k of ["effort", "reasoning_effort", "reasoningEffort"]) {
    const v = typeof req[k] === "string" ? req[k].trim() : "";
    if (v) body[k] = v;
  }
  if (req.extra_body != null) body.extra_body = req.extra_body;
  // output_config.effort 是 Claude Code 的另一档位载体（beta），原始对象上游不认故不外发，
  // 但档位本身不能丢 → 归一到 reasoning_effort（客户端已显式声明时以声明为准）。
  const ocEffort = req.output_config && typeof req.output_config === "object" ? req.output_config.effort : undefined;
  if (ocEffort != null && body.reasoning_effort == null && body.reasoningEffort == null) {
    body.reasoning_effort = ocEffort;
  }
  return body;
}
