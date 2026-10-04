// vendor 自 src/providers/qwenwork/payload.js（OpenAI body → agent_chat 请求体）逐字搬；
// **唯一实质改动 = mapModel 的模型名表**：国际站 qwork 切片是 qwork-auto/qwork-advanced，
// 与 cn 站的 flash/pro/qwen3.8-max-preview 完全不同池（2026-10-01 现网取证）。
// 实测通过的字段形状（.ai 真号 200 出词）：request_id==request_set_id==chat_record_id、
// stream 恒 true、system 抽到顶层且不出现在 messages、parameters.max_tokens 默认 32000。
import { uuid } from "./crypto.js";
import { DEFAULT_MODEL, BUSINESS_PRODUCT, BUSINESS_TYPE, CONTEXT_LENGTH } from "./constants.js";

export function mapModel(name) {
  const m = String(name || "").trim();
  switch (m) {
    case "":
    case "auto":
    case "standard":
    case "lite":
    case "flash":
    case "qwork-auto":
      return "qwork-auto";
    case "advanced":
    case "pro":
    case "max":
    case "qwork-advanced":
      return "qwork-advanced";
    default:
      return m;
  }
}

function contentText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    let out = "";
    for (const part of value) {
      if (part && typeof part === "object" && typeof part.text === "string") out += part.text;
    }
    return out;
  }
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

function splitMessages(payload) {
  const raw = Array.isArray(payload.messages) ? payload.messages : [];
  const sysParts = [];
  const messages = [];
  let lastUser = "";
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    if (item.role === "system") {
      const text = contentText(item.content);
      if (text) sysParts.push(text);
      continue;
    }
    messages.push(item);
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") {
      lastUser = contentText(m.content);
      break;
    }
  }
  return { system: sysParts.join("\n\n"), messages, lastUser };
}

export function buildBody(payload, modelKey) {
  const key = modelKey || DEFAULT_MODEL;
  const requestID = uuid();
  const { system, messages, lastUser: first } = splitMessages(payload);
  let lastUser = first;
  if (!lastUser) {
    for (const m of messages) {
      if (m && m.role === "user") {
        lastUser = contentText(m.content);
        if (lastUser) break;
      }
    }
  }
  if (!lastUser) lastUser = "ping";

  const tokenCap = payload.max_completion_tokens !== undefined ? payload.max_completion_tokens : payload.max_tokens;
  const parameters = {};
  for (const k of ["temperature", "top_p", "presence_penalty", "frequency_penalty"]) {
    if (payload[k] !== undefined && payload[k] !== null) parameters[k] = payload[k];
  }
  if (tokenCap !== undefined && tokenCap !== null) {
    const n = Number(tokenCap);
    if (Number.isFinite(n) && n > 0) parameters.max_tokens = Math.floor(n);
  }
  if (parameters.max_tokens === undefined) parameters.max_tokens = 32000;

  const tools = !(payload.tool_choice === "none") && Array.isArray(payload.tools) ? payload.tools : [];
  // 国际站 qwork 切片两模型均 is_reasoning=false（cn 站为 true），故保持 false 与上游目录一致。
  const isReasoning = false;

  return JSON.stringify({
    request_id: requestID,
    request_set_id: requestID,
    chat_record_id: requestID,
    session_id: uuid(),
    stream: true,
    chat_task: "FREE_INPUT",
    chat_context: {
      text: lastUser,
      features: [],
      extra: {
        context: [],
        modelConfig: { key, is_reasoning: isReasoning },
        originalContent: lastUser,
      },
      chatPrompt: "",
      imageUrls: null,
    },
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    agent_id: "agent_common",
    task_id: "common",
    session_type: "qoder_work",
    aliyun_user_type: "",
    model_config: {
      key,
      display_name: key,
      model: "",
      format: "openai",
      is_vl: true,
      is_reasoning: isReasoning,
      api_key: "",
      url: "",
      source: "system",
      max_input_tokens: CONTEXT_LENGTH,
    },
    system,
    messages,
    tools,
    parameters,
    business: {
      product: BUSINESS_PRODUCT,
      type: BUSINESS_TYPE,
      version: "1",
      feature_switches: {},
    },
  });
}
