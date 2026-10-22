// qoder 请求体装配（对齐官方 qodercli 线格式；外部参考：dsh-qoder-connect wire/serialize.ts、magpie qoder 插件）。
// 消息形状转换层（OpenAI→Qoder wire messages / 会话指纹 / 缓存标记 / tool 配对）已拆至 wire-messages.js
// （体积门 + 职责边界）。本文件只管：
//  - 模板外壳加载（baseprompt.json 只作 parameters/model_config 骨架，messages/tools 一律重建）；
//  - business.id = request_set_id（上游把排队条目与 business id 绑定，各发一个 UUID 会让排队/回放关联失效）；
//  - business.product=cli（我们伪装的是 qodercli，不是 IDE）；
//  - 思考档位/上下文窗口按模型目录（meta）补写；模型名映射 mapModel。
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { newUUID, unixMs } from "./fingerprint.js";
import {
  normalizeContent, buildUserMessage, buildStructuredMessage,
  toQoderWireMessages, conversationSessionId, cacheMark,
} from "./wire-messages.js";

// 转换层符号 re-export（外部 import 路径保持 payload.js 不变；新代码建议直接 import wire-messages.js）
export {
  blankResponseMeta, buildUserMessage, buildStructuredMessage, normalizeContent,
  withQoderPersona, toQoderWireMessages, conversationSessionId, cacheMark,
} from "./wire-messages.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 模板单例：进程内加载一次（替换占位符后 JSON.parse）
let _template = null;
export function loadTemplate(templatePath) {
  if (_template && !templatePath) return _template;
  let tmpl = readFileSync(templatePath || join(__dirname, "baseprompt.json"), "utf8");
  for (const k of ["{UUID1}", "{UUID2}", "{UUID3}", "{UUID4}", "{UUID5}"]) tmpl = tmpl.split(k).join(newUUID());
  tmpl = tmpl.split("{TIME1}").join(String(unixMs()));
  _template = JSON.parse(tmpl);
  return _template;
}

// 档位对齐（参考 magpie effortFor）：把客户端要档位映射到模型声明档位集合里的最近一档（平手取高）。
const EFFORT_RANK = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
export function fitEffort(want, levels) {
  const w = String(want || "").toLowerCase();
  if (!Array.isArray(levels) || !levels.length || levels.includes(w)) return w;
  const at = EFFORT_RANK.indexOf(w);
  if (at < 0) return w;
  let best = w, dist = EFFORT_RANK.length;
  for (const l of levels) {
    const i = EFFORT_RANK.indexOf(l);
    if (i < 0 || l === "none") continue;
    const d = Math.abs(i - at);
    if (d < dist || (d === dist && i > at)) { best = l; dist = d; }
  }
  return best;
}

// 上下文窗口选择（参考 magpie windowFor）：请求装得下默认窗口就用默认；
// 装不下按能容纳的最小窗口升档（bytes/3 粗估 + 预留回复长度），全装不下给最大档。
export function pickContextWindow(need, meta) {
  const base = Number(meta?.defaultWindow) || Number(meta?.context_length) || 0;
  const windows = Array.isArray(meta?.windows) ? meta.windows : [];
  if (base > 0 && need <= base) return base;
  return windows.find((w) => w >= need) ?? (windows.length ? windows[windows.length - 1] : 0);
}

// 组装上游请求体。template 外壳字段（parameters/model_config 骨架等）保留，
// messages/tools/ids/chat_context/business 一律重建。
// meta：模型目录行（context_windows/default_window/reasoning_efforts/default_reasoning_effort/max_output_tokens）；
// effort：客户端声明的思考档位原始串（可空）。
export function buildQoderBody({ template, userId, userType, model, messages, tools, maxTokens, isReasoning, meta, effort, preserveTemplateHistory = false }) {
  const tmpl = template || loadTemplate();
  const body = JSON.parse(JSON.stringify(tmpl));
  const nid = newUUID();
  const setId = newUUID();
  body.request_id = nid;
  body.chat_record_id = nid;
  body.request_set_id = setId;
  body.stream = true;
  body.aliyun_user_type = userType || "personal_standard";
  if (body.model_config) {
    body.model_config.key = model;
    if (isReasoning) body.model_config.is_reasoning = true;
  }
  // 推理标志两处镜像写（对齐官方 CLI 请求形状），只写 model_config 上游不吐 reasoning_content
  if (isReasoning && body.chat_context?.extra?.modelConfig) {
    body.chat_context.extra.modelConfig.is_reasoning = true;
    body.chat_context.extra.modelConfig.key = model; // 与 model_config.key 同步，不留模板 "auto"
  }
  const wireMessages = cacheMark(preserveTemplateHistory
    ? buildQoderMessages(tmpl, messages, Array.isArray(tools) && tools.length > 0) // 回退通道：MSLXDFF_QODER_LEGACY_WIRE=1
    : toQoderWireMessages(messages));
  body.session_id = conversationSessionId(userId, model, wireMessages);
  const outCap = maxTokens > 0 ? maxTokens : (Number(meta?.max_output_tokens) || 0);
  if (outCap > 0 && body.parameters) body.parameters.max_tokens = outCap;
  // 思考参数按真值口径补写（models.js 目录行为 snake_case）：enable_thinking + 命中模型声明档位才发 reasoning_effort。
  // 只在模型确实支持时补写，避免把未知参数/无效档位打给不认的模型（fitEffort 兜底后仍须 ∈ efforts 才发）。
  if (body.parameters) {
    const efforts = Array.isArray(meta?.reasoning_efforts) ? meta.reasoning_efforts : [];
    const want = String(effort || "").trim().toLowerCase();
    if (isReasoning) {
      body.parameters.enable_thinking = true;
      if (efforts.length) {
        const cand = want && EFFORT_RANK.includes(want)
          ? fitEffort(want, efforts)
          : String(meta?.default_reasoning_effort || efforts[0] || "");
        if (efforts.includes(cand)) body.parameters.reasoning_effort = cand;
      }
    } else if (want === "none" && efforts.length) {
      body.parameters.enable_thinking = false; // 模型可关思考才发关；不可关的（无 efforts）保持默认不干预
    }
    // 上下文窗口升档（仅模型声明了多窗口才发）
    const windows = Array.isArray(meta?.context_windows) ? meta.context_windows : [];
    if (windows.length) {
      const need = Math.ceil(JSON.stringify({ m: wireMessages, t: tools || [] }).length / 3) + (outCap || 32000);
      const w = pickContextWindow(need, { defaultWindow: meta.default_window, context_length: meta.context_length, windows });
      if (w > 0) body.parameters.context_length = w;
    }
  }
  // chat_context 的 text/originalContent 是纯字符串（旧模板形状是 {type,text} 对象——官方从不发对象形状）
  const prompt = (() => {
    for (let i = wireMessages.length - 1; i >= 0; i--) {
      const m = wireMessages[i];
      if (m?.role === "user") return normalizeContent(m.contents?.map((p) => p.text ?? "").join("\n\n") || m.content);
    }
    return "";
  })();
  if (body.business) {
    body.business.id = setId; // 排队条目与 business.id 绑定，必须 = request_set_id
    body.business.product = "cli";
    body.business.version = "1.0.0";
    body.business.begin_at = unixMs();
    body.business.name = prompt.length > 30 ? prompt.slice(0, 30) : prompt;
  }
  if (body.chat_context) {
    body.chat_context.text = prompt;
    if (body.chat_context.extra) body.chat_context.extra.originalContent = prompt;
  }
  body.messages = wireMessages;
  // tools 空数组契约：模板内嵌的 14 个 Qoder CLI 工具永不出门；无工具时上游官方亦发 []
  body.tools = Array.isArray(tools) && tools.length ? tools : [];
  return { body, prompt, mcSource: body.model_config?.source || "system" };
}

// OpenAI messages → Qoder messages（旧版形状：无 system 前置模板 system；user=contents[]；
// assistant tool_calls 透传；含 tool_result 数组拆成 tool 行）。
// 仅保留给 MSLXDFF_QODER_LEGACY_WIRE=1 回退通道；正常路径用 wire-messages.js 的 toQoderWireMessages。
export function buildQoderMessages(template, incoming, toolsEnabled) {
  const rebuilt = [];
  const hasSystem = (incoming || []).some((m) => m?.role === "system");
  if (!hasSystem && template) {
    for (const m of template.messages || []) {
      if (m?.role === "system") rebuilt.push(JSON.parse(JSON.stringify(m)));
    }
  }
  for (const m of incoming || []) {
    if (!m || typeof m !== "object") continue;
    const text = normalizeContent(m.content);
    if (m.role === "user") {
      // tool_result 数组形态 → tool 行
      if (Array.isArray(m.content) && m.content[0]?.type === "tool_result") {
        for (const b of m.content) {
          if (b?.type !== "tool_result") continue;
          rebuilt.push({ role: "tool", tool_call_id: b.tool_use_id || "", content: normalizeContent(b.content) });
        }
        continue;
      }
      rebuilt.push(buildUserMessage(text));
    } else if (m.role === "assistant" && toolsEnabled && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const out = buildStructuredMessage("assistant", text);
      out.tool_calls = m.tool_calls;
      rebuilt.push(out);
    } else if (m.role === "tool") {
      const out = buildStructuredMessage("tool", text);
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      if (m.name) out.name = m.name;
      rebuilt.push(out);
    } else if (text) {
      rebuilt.push(buildStructuredMessage(m.role === "system" ? "system" : m.role || "user", text));
    }
  }
  return rebuilt;
}

// 客户端模型名 → 上游 key（仿 defaultModelMapping 双向 substring，家族关键字兜底）
const DEFAULT_MAPPING = {
  opus: "qmodel_38max", sonnet: "gmodel", haiku: "qfmodel",
  gpt: "dmodel", gemini: "gmodel", glm: "gmodel", kimi: "kmodel", deepseek: "dmodel",
  qwen: "qfmodel", flash: "qfmodel", mini: "efficient", pro: "performance", max: "performance",
};
// 上游原生 key 白名单（model/list 实测 15 个）——精确命中直接透传，防被家族关键字抢走
const UPSTREAM_KEYS = new Set(["auto", "ultimate", "performance", "efficient", "qmodel_38max", "qfmodel", "qmodel_latest", "qmodel", "kmodel_latest", "kmodel", "gmodel", "gfmodel", "dmodel", "dfmodel", "mmodel"]);
export function mapModel(model) {
  const m = String(model || "").trim();
  if (!m || m.toLowerCase() === "auto") return "qfmodel";
  const low = m.toLowerCase();
  if (UPSTREAM_KEYS.has(low)) return low;
  if (DEFAULT_MAPPING[low]) return DEFAULT_MAPPING[low];
  for (const [k, v] of Object.entries(DEFAULT_MAPPING)) {
    if (low.includes(k) || k.includes(low)) return v;
  }
  return low;
}
