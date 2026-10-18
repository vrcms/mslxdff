// 请求侧翻译：Anthropic Messages 请求体 → OpenAI chat 请求体（/v1/messages 外壳，ADR-0047）。
// 从 translate.js 拆出（ADR-0055）：translate.js 贴 20KB 体积硬门，且「入站请求形状」与
// 「出站响应/usage 翻译」本就是两向关注点，拆后 translate.js 单向 import 本文件，不回环。
// 对外接口不变：调用方与测试仍从 anthropic/translate.js import（那边 re-export）。
//
// 形状对齐（1:1 照抄 cc-switch `src-tauri/src/proxy/providers/transform.rs:236-402`，只服务 /v1/messages）：
//  * system 块间用 "\n" 拼成**一条**；逐块剥开头的 `x-anthropic-billing-header:` 行（#2350：
//    该行带轮换 `cch=`，留在前缀位置会让上游前缀缓存每轮失效 → 每轮全量 prefill）；
//  * `tool_use.arguments` 走 canonical JSON；出站体整体 canonicalize（键序恒定 = 字节前缀稳定）；
//  * tool_result 里的媒体外移成一条 user 消息（改前是静默丢图）；
//  * tools 过滤 `BatchTool`、description 缺省不写、`input_schema` 过 cleanToolSchema；
//  * o 系列 `max_tokens` → `max_completion_tokens`；`stream_options` 改 merge 不覆盖。
//
// 纪律（别改回去）：
//  * 思考档位**原样透传**（thinking/effort/reasoning_effort/reasoningEffort/extra_body），语义归一交给
//    各 provider 与 src/thinking-effort.js —— 旧版在此丢掉，下游被迫补默认值（workbuddy 恒 high，ADR-0053）；
//    此处刻意**不**照抄 cc-switch 的 thinking→reasoning_effort 本地映射表（transform.rs:100-190）；
//  * 但**必须主动丢** output_config 原始对象 / context_management / 消息块内 thinking：Claude Code 对
//    不认识的 model ID 照发全套字段，块内 thinking 无法签发 signature，回传必被上游拒（ADR-0047）；
//  * 空会话抛错，绝不伪造一句 "hi" 打上游（会把假提问写进用户上下文并白烧一发额度）；
//  * tool_result 重复 tool_use_id 保首个、丢后续（部分上游按 call_id 查重直接 400）；
//    `is_error` 保留 `[tool_error]` 前缀（上游可见的错误信号，别照抄 cc-switch 丢掉）。
import { isServerTool } from "./web-search.js";
import { newToolUseId } from "./shared.js";
import { canonicalJson, canonicalizeValue } from "./canonical-json.js";
import { stripLeadingBillingHeader, cleanToolSchema, isOpenAiOSeries } from "./request-shape.js";
import { imagePartOf, planToolResultMedia, queueToolMedia, flushToolMedia } from "./tool-media.js";

// system 允许字符串或 text 块数组；块间用 "\n" 连接（照抄 cc-switch：跨轮字节稳定）。
// 逐块剥开头的计费头：它每轮变一次，是前缀缓存失效的头号嫌疑人（cc-switch #2350）。
function systemTextOf(system) {
  const one = (t) => stripLeadingBillingHeader(typeof t === "string" ? t : "");
  if (typeof system === "string") return one(system);
  if (!Array.isArray(system)) return "";
  return system
    .map((b) => one(b && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** tool_result 的 content → 纯文本（字符串原样；块数组取各 text；其余 String()）。 */
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
  // 工具结果里的媒体暂存：同轮普通消息之前冲成一条 user 消息（Chat 的 tool 消息不能带图分片）
  const pendingMedia = [];

  for (const m of Array.isArray(req.messages) ? req.messages : []) {
    if (!m || typeof m !== "object") continue;
    // role=system/developer 必须保留：Claude Code ≥2.1.286 的 mid-conversation system beta 就往 messages[] 里塞系统指令，
    const role = m.role === "assistant" ? "assistant" : m.role === "system" || m.role === "developer" ? "system" : "user";
    if (typeof m.content === "string") {
      if (m.content) messages.push({ role, content: m.content });
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content : null;
    if (!blocks) {
      if (m.content != null) messages.push({ role, content: m.content }); // 其它形状原样透传
      continue;
    }
    const parts = []; // text / image 分片（照抄 cc-switch 的 content_parts）
    const toolCalls = [];
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text") {
        if (typeof b.text === "string" && b.text) parts.push({ type: "text", text: b.text });
      } else if (b.type === "image") {
        const p = imagePartOf(b);
        if (p) parts.push(p);
      } else if (b.type === "tool_use") {
        toolCalls.push({
          id: String(b.id || newToolUseId()),
          type: "function",
          function: { name: String(b.name || ""), arguments: canonicalJson(b.input ?? {}) },
        });
      } else if (b.type === "tool_result") {
        // tool 消息必须先于同轮 user 文本进数组：OpenAI 侧要求 role:tool 紧跟其 assistant
        const key = String(b.tool_use_id || "");
        if (key) { if (seenToolResult.has(key)) continue; seenToolResult.add(key); }
        const plan = planToolResultMedia(b.content, canonicalJson);
        let text;
        if (plan) { queueToolMedia(pendingMedia, key, plan.media); text = plan.text; }
        else text = toolResultTextOf(b.content);
        messages.push({ role: "tool", tool_call_id: key, content: b.is_error ? `[tool_error] ${text}` : text });
      }
      // thinking / redacted_thinking 忽略：我们无法签发 signature，回传必被上游拒（ADR-0047）
    }
    // 媒体先给、再给同轮普通内容（照抄 cc-switch transform.rs:517 的顺序）
    flushToolMedia(messages, pendingMedia);
    if (!parts.length && !toolCalls.length) continue;
    // 单 text 分片化简成纯字符串；无分片给 null（照抄 transform.rs:524-535）
    const content = parts.length === 0 ? null
      : parts.length === 1 && parts[0].type === "text" ? parts[0].text
        : parts;
    const msg = { role, content };
    if (toolCalls.length) msg.tool_calls = toolCalls;
    messages.push(msg);
  }
  flushToolMedia(messages, pendingMedia); // 尾部残余（末条就是工具轮时）
  // 空会话直接 400：绝不伪造一句 "hi" 打上游（那会把假提问写进用户上下文并白烧一发额度）
  if (!messages.some((x) => x.role !== "system")) throw new Error("messages: 缺少用户消息");

  const body = { model, messages, stream: Boolean(req.stream) };
  // o 系列必须用 max_completion_tokens（照抄 cc-switch transform.rs:278-286）
  if (req.max_tokens != null && Number.isFinite(Number(req.max_tokens))) {
    if (isOpenAiOSeries(model)) body.max_completion_tokens = Number(req.max_tokens);
    else body.max_tokens = Number(req.max_tokens);
  }
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
  // 流式必须让上游把 usage 放进收尾帧，否则 message_delta.usage 恒 0（OpenAI 规范字段）。
  // 照抄 cc-switch transform.rs:349-365：**merge** 客户端既有 stream_options，而不是整段覆盖。
  // 个别上游不认 stream_options 会 400 → `MSLXDFF_ANTHROPIC_STREAM_USAGE=0` 关掉。
  if (body.stream && process.env.MSLXDFF_ANTHROPIC_STREAM_USAGE !== "0") {
    const opts = req.stream_options && typeof req.stream_options === "object" ? req.stream_options : {};
    body.stream_options = { ...opts, include_usage: true };
  }
  // Anthropic 的 server tool（web_search_*/web_fetch_*/…）没有 input_schema，折成假 function 会
  // 让上游收到「空参数空描述」的工具（严格端点直接 422），本网关不实现的发前一律剥除（ADR-0049）；
  // 另外照抄 cc-switch 剥 `BatchTool`、description 缺省不写、schema 过 cleanToolSchema。
  const fnTools = (Array.isArray(req.tools) ? req.tools : [])
    .filter((t) => !isServerTool(t))
    .filter((t) => String(t?.type || "") !== "BatchTool");
  if (fnTools.length) {
    body.tools = fnTools.map((t) => {
      const fn = { name: String(t?.name || "") };
      if (typeof t?.description === "string" && t.description) fn.description = t.description;
      fn.parameters = cleanToolSchema(t?.input_schema ?? {});
      return { type: "function", function: fn };
    });
  }
  const keptNames = new Set(fnTools.map((t) => String(t?.name || "")));
  const tc = req.tool_choice;
  if (typeof tc === "string") {
    // 字符串形态：Anthropic 的 "any" → OpenAI 的 "required"（照抄 transform.rs:381-386）
    if (tc === "any") body.tool_choice = "required";
    else if (tc) body.tool_choice = tc;
  } else if (tc && typeof tc === "object") {
    if (tc.type === "auto") body.tool_choice = "auto";
    else if (tc.type === "any") body.tool_choice = "required";
    // 点名一个已被剥掉的工具时降为 auto：上游会按不存在的函数强制点名，那样一定拿不到有用回答
    else if (tc.type === "tool") body.tool_choice = keptNames.has(String(tc.name || "")) ? { type: "function", function: { name: String(tc.name || "") } } : "auto";
    else if (tc.type === "none") body.tool_choice = "none";
  }
  // 出站体键序规范化：同一逻辑内容必然产出同一份字节 → 上游前缀缓存能稳定命中
  // （照抄 cc-switch forwarder.rs prepare_upstream_request_body / json_canonical.rs）。
  return canonicalizeValue(body);
}
