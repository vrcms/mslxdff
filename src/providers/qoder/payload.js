// qoder 消息/payload 组装（转译 qoder2api bridge.go CallQoderWithOpts + messages.go）
// 模板：baseprompt.json（vendored 数据文件，含 {UUID1..5}/{TIME1} 占位符，加载时替换一次）
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { newUUID, unixMs } from "./fingerprint.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 模板单例：进程内加载一次（替换占位符后 JSON.parse），每请求深拷贝
let _template = null;
export function loadTemplate(templatePath) {
  if (_template && !templatePath) return _template;
  let tmpl = readFileSync(templatePath || join(__dirname, "baseprompt.json"), "utf8");
  for (const k of ["{UUID1}", "{UUID2}", "{UUID3}", "{UUID4}", "{UUID5}"]) tmpl = tmpl.split(k).join(newUUID());
  tmpl = tmpl.split("{TIME1}").join(String(unixMs()));
  _template = JSON.parse(tmpl);
  return _template;
}

export function blankResponseMeta() {
  return {
    id: "",
    usage: {
      prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
      completion_tokens_details: { reasoning_tokens: 0 },
      prompt_tokens_details: { cached_tokens: 0 },
    },
  };
}

// OpenAI user 消息 → Qoder contents 形状
export function buildUserMessage(text) {
  return {
    role: "user", content: "",
    contents: [{ type: "text", text: String(text || "") }],
    response_meta: blankResponseMeta(),
    reasoning_content_signature: "",
  };
}

export function buildStructuredMessage(role, text) {
  return { role, content: String(text || ""), response_meta: blankResponseMeta(), reasoning_content_signature: "" };
}

export function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    let out = "";
    for (const b of content) {
      const t = typeof b === "object" && b ? b.text : b;
      if (typeof t === "string") out += (out ? "\n\n" : "") + t;
    }
    return out;
  }
  return JSON.stringify(content);
}

// 提取最后一条 user 消息文本（仿 ExtractLatestUserPrompt）
export function extractLatestUserPrompt(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") return normalizeContent(m.content);
  }
  return "";
}

// OpenAI messages → Qoder messages（仿 BuildQoderMessages：无 system 前置模板 system；
// user 含 tool_result 数组拆成 tool 行；assistant tool_calls 透传）
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

// 组装上游请求体（仿 CallQoderWithOpts）
export function buildQoderBody({ template, userType, model, messages, tools, maxTokens, isReasoning }) {
  const body = JSON.parse(JSON.stringify(template || loadTemplate()));
  const nid = newUUID();
  body.request_id = nid;
  body.chat_record_id = nid;
  body.request_set_id = newUUID();
  body.session_id = newUUID();
  body.stream = true;
  body.aliyun_user_type = userType || "personal_standard";
  if (body.model_config) {
    body.model_config.key = model;
    if (isReasoning) body.model_config.is_reasoning = true;
  }
  if (maxTokens > 0 && body.parameters) body.parameters.max_tokens = maxTokens;
  const prompt = extractLatestUserPrompt(messages);
  if (body.business) {
    body.business.id = newUUID();
    body.business.begin_at = unixMs();
    body.business.name = prompt.length > 30 ? prompt.slice(0, 30) : prompt;
  }
  if (body.chat_context) {
    if (body.chat_context.text) body.chat_context.text.text = prompt;
    if (body.chat_context.extra?.originalContent) body.chat_context.extra.originalContent.text = prompt;
  }
  body.messages = messages;
  if (tools != null) body.tools = tools;
  return { body, prompt, mcSource: body.model_config?.source || "system" };
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
