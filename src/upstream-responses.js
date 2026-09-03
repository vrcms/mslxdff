/**
 * responses 转换层 — 从 upstream.js 抽出的 muse-spark 专用形状转换。
 * chat ⇄ responses 互转纯函数，无网络、无副作用。
 */
export function isResponsesModel(model) {
  return String(model || "").toLowerCase().startsWith("muse-spark");
}

export function chatToResponsesBody(chatBody) {
  const msgs = Array.isArray(chatBody?.messages) ? chatBody.messages : [];
  const system = msgs.filter((m) => m.role === "system").map((m) => String(m.content || "")).join("\n");
  const nonSystem = msgs.filter((m) => m.role !== "system");
  const inputParts = nonSystem.map((m) => {
    const c = m.content;
    if (typeof c === "string") return `${m.role}: ${c}`;
    if (Array.isArray(c)) return `${m.role}: ${c.map((x) => x.text || "").join("")}`;
    return `${m.role}: ${String(c || "")}`;
  });
  const input = inputParts.join("\n\n") || "hi";
  const out = { model: chatBody.model, input, stream: false };
  if (system) out.instructions = system;
  if (chatBody.tools) out.tools = chatBody.tools;
  if (chatBody.tool_choice) out.tool_choice = chatBody.tool_choice;
  if (chatBody.temperature != null) out.temperature = chatBody.temperature;
  if (chatBody.max_tokens != null) out.max_output_tokens = chatBody.max_tokens;
  return out;
}

export function responsesToChatJson(respJson) {
  let text = "";
  for (const item of respJson.output || []) {
    if (item.type === "message" && item.role === "assistant") {
      for (const c of item.content || []) {
        if (c.type === "output_text") text += c.text || "";
        else if (c.type === "text") text += c.text || "";
      }
    }
  }
  if (!text) {
    for (const item of respJson.output || []) {
      if (item.type === "message") {
        const t = item.content?.[0]?.text;
        if (t) { text = t; break; }
      }
    }
  }
  const chatJson = {
    id: respJson.id || `resp_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor((respJson.created_at || Date.now() / 1000)),
    model: respJson.model,
    choices: [{ index: 0, finish_reason: respJson.status === "completed" ? "stop" : "length", message: { role: "assistant", content: text } }],
    usage: respJson.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  return chatJson;
}

/** responses 成功 Response 转回 chat 形状（anon 兜底与主路径复用） */
export function toChatResponse(res, respJson) {
  const chatJson = responsesToChatJson(respJson);
  const headers = new Headers(res.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(chatJson), { status: res.status, headers });
}
