// OpenAI 请求体 → @ai-sdk/openai-compatible 入参（仅 chat）。
// 显式映射常用面；未映射字段经 toProviderExtras 原样透传（providerOptions.<providerName> 会被 spread 进请求体）。
// 共用库：workbuddy 实验通道与 upstream-engine 同源。见 .scratch/ai-sdk-upstream/SPEC.md。

const HANDLED_KEYS = new Set([
  "model", "messages", "stream", "tools", "tool_choice",
  "temperature", "top_p", "max_tokens", "stop",
  "presence_penalty", "frequency_penalty", "seed", "reasoning_effort",
]);

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("");
  }
  return "";
}

// 图片 → AI SDK 的 file part（mediaType 为 image/*）。
// 为什么不是 {type:"image"}：AI SDK v3 的 prompt 校验没有 image part 类型，会被序列化成
// null 发给上游 → 400 "input[N].content did not match any supported type"（2026-09-22 实测）。
// file part + image/* 才是 @ai-sdk/openai responses 适配器产出 input_image 的正道
// （dist/index.mjs：mediaType.startsWith("image/") → {type:"input_image", image_url}）。
// mediaType 从 data URL 提取真实类型：通配 "image/*" 会被 SDK 强转成 "image/jpeg"。
function filePartFromImageUrl(url) {
  const m = /^data:([^;,]*)[^,]*,/.exec(url);
  const mediaType = m && m[1] ? m[1] : "image/*";
  try {
    return { type: "file", mediaType, data: new URL(url) };
  } catch {
    return null;
  }
}

function userContentParts(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [{ type: "text", text: String(content ?? "") }];
  const parts = [];
  for (const p of content) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "text" || p.type === "input_text") {
      parts.push({ type: "text", text: String(p.text ?? "") });
    } else if (p.type === "image_url" || p.type === "input_image" || p.image_url != null) {
      const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
      if (!url) continue;
      const fp = filePartFromImageUrl(url);
      if (fp) parts.push(fp);
    }
  }
  if (!parts.length) parts.push({ type: "text", text: "" });
  return parts;
}

function parseToolArgs(raw) {
  if (raw && typeof raw === "object") return raw;
  try { return JSON.parse(String(raw)); } catch { return {}; }
}

export function toModelPrompt(messages, { dropEncrypted = false } = {}) {
  const out = [];
  // 上游按 item id 查重：同一 reasoning item 重复出现 → 400 "Duplicate item found"
  // （上游报错原文即要求 Remove duplicate items）。这里按 itemId 保首个、丢后续，
  // 防客户端重放/其他生产者把同一加密 item 组装两次。
  const seenReasoningIds = new Set();
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== "object") continue;
    const role = String(m.role || "");
    if (role === "system" || role === "developer") {
      out.push({ role: "system", content: textOf(m.content) });
    } else if (role === "user") {
      out.push({ role: "user", content: userContentParts(m.content) });
    } else if (role === "assistant") {
      const parts = [];
      const text = textOf(m.content);
      if (text) parts.push({ type: "text", text });
      // 无加密态时才退回纯文本 reasoning（chat 通道的 reasoning_content）。
      // 空串是 payload 回填的有意标记（requiresReasoningContentOnAssistantMessages）：所有 assistant
      // 必须带该字段——AI SDK 以 length>0 判定是否输出，故用 " " 占位而非 ""。
      // dropEncrypted：上游拒收跨 caller 的加密态时的降级重试——只留可读摘要（无摘要则整条跳过，
      // 留给下面的明文 reasoning_content 兜底），不置 pushedEncrypted。
      const items = Array.isArray(m.reasoning_items) ? m.reasoning_items : [];
      let pushedEncrypted = false;
      for (const r of items) {
        if (!r || typeof r !== "object") continue;
        // 重复 id 的加密 item 直接跳过：上游按 item id 查重（Duplicate item found 400），
        // 重复项无合法语义，保首个即可（首个已带全量 encrypted_content）。
        if (r.id && seenReasoningIds.has(String(r.id))) continue;
        if (r.id) seenReasoningIds.add(String(r.id));
        const summaryText = Array.isArray(r.summary) ? r.summary.map((s) => s?.text || "").join("\n") : "";
        if (dropEncrypted) {
          if (summaryText) parts.push({ type: "reasoning", text: summaryText });
          continue;
        }
        parts.push({
          type: "reasoning",
          text: summaryText || " ",
          providerOptions: { openai: { itemId: r.id, reasoningEncryptedContent: r.encrypted_content } },
        });
        pushedEncrypted = true;
      }
      const rc = typeof m.reasoning_content === "string" ? m.reasoning_content
        : (typeof m.reasoning === "string" ? m.reasoning : null);
      if (!pushedEncrypted && rc !== null) parts.push({ type: "reasoning", text: rc || " " });
      for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        if (!tc || typeof tc !== "object") continue;
        parts.push({
          type: "tool-call",
          toolCallId: String(tc.id || ""),
          toolName: String(tc.function?.name || ""),
          input: parseToolArgs(tc.function?.arguments),
        });
      }
      out.push({ role: "assistant", content: parts });
    } else if (role === "tool") {
      out.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: String(m.tool_call_id || ""),
          toolName: String(m.name || "tool"),
          output: { type: "text", value: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "") },
        }],
      });
    }
  }
  return out;
}

export function toModelTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = tools
    .filter((t) => t && t.type === "function" && t.function?.name)
    .map((t) => ({
      type: "function",
      name: String(t.function.name),
      description: t.function.description ? String(t.function.description) : undefined,
      inputSchema: t.function.parameters && typeof t.function.parameters === "object"
        ? t.function.parameters
        : { type: "object", properties: {} },
    }));
  return out.length ? out : undefined;
}

export function toModelToolChoice(choice) {
  if (!choice) return undefined;
  if (typeof choice === "string") {
    return ["auto", "none", "required"].includes(choice) ? { type: choice } : undefined;
  }
  if (choice.type === "function" && choice.function?.name) {
    return { type: "tool", toolName: String(choice.function.name) };
  }
  return undefined;
}

export function toProviderExtras(body) {
  const extras = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (!HANDLED_KEYS.has(k) && v !== undefined) extras[k] = v;
  }
  return Object.keys(extras).length ? extras : undefined;
}

export function toModelParams(body, providerName = "opencode") {
  const params = {};
  if (body?.max_tokens != null) params.maxOutputTokens = body.max_tokens;
  if (body?.temperature != null) params.temperature = body.temperature;
  if (body?.top_p != null) params.topP = body.top_p;
  if (body?.presence_penalty != null) params.presencePenalty = body.presence_penalty;
  if (body?.frequency_penalty != null) params.frequencyPenalty = body.frequency_penalty;
  if (Array.isArray(body?.stop)) params.stopSequences = body.stop;
  else if (typeof body?.stop === "string" && body.stop) params.stopSequences = [body.stop];
  if (body?.seed != null) params.seed = body.seed;
  const providerOptions = {};
  if (body?.reasoning_effort != null) {
    providerOptions.openaiCompatible = { reasoningEffort: String(body.reasoning_effort) };
  }
  const extras = toProviderExtras(body);
  if (extras) providerOptions[providerName] = extras;
  if (Object.keys(providerOptions).length) params.providerOptions = providerOptions;
  return params;
}
