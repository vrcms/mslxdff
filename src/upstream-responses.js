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
  // responses 的 tools 形状为平铺 {type,name,description,parameters}，而 chat 为 {type,function:{name,...}}
  if (Array.isArray(chatBody.tools) && chatBody.tools.length) {
    const mapped = chatBody.tools.map((t) => {
      if (!t || typeof t !== "object") return null;
      if (t.type === "function" && t.function && typeof t.function === "object") {
        const fn = t.function;
        const nt = { type: "function", name: fn.name, description: fn.description || undefined, parameters: fn.parameters || undefined };
        // 清理 undefined
        Object.keys(nt).forEach((k) => nt[k] === undefined && delete nt[k]);
        return nt.name ? nt : null;
      }
      // 已是平铺形态或未知形态，透传但确保 name 存在
      if (t.name) return t;
      return null;
    }).filter(Boolean);
    if (mapped.length) out.tools = mapped;
  }
  if (chatBody.tool_choice) {
    const tc = chatBody.tool_choice;
    // chat: "auto" | {type:"auto"} | {type:"function", function:{name}} -> responses: "auto" | {type:"function", name}
    if (typeof tc === "string") out.tool_choice = tc;
    else if (tc && typeof tc === "object") {
      if (tc.type === "function" && tc.function?.name) out.tool_choice = { type: "function", name: tc.function.name };
      else if (tc.type) out.tool_choice = tc;
      else out.tool_choice = tc;
    }
  }
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

export function reshapeResponsesSse(res, fallbackModel) {
  try {
    const ct = res.headers?.get?.("content-type") || "";
    if (res.status !== 200 || !ct.includes("text/event-stream") || !res.body) return res;
  } catch { return res; }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  let evtType = "";
  let respId = "";
  let respModel = fallbackModel || "";
  let created = Math.floor(Date.now() / 1000);
  let hasSentRole = false;

  function chatChunk(delta, finish) {
    const id = respId || `resp_${Date.now()}`;
    const payload = {
      id,
      object: "chat.completion.chunk",
      created,
      model: respModel,
      choices: [{ index: 0, delta: delta || {}, finish_reason: finish || null }],
    };
    return `data: ${JSON.stringify(payload)}\n\n`;
  }

  let closed = false;
  const body = new ReadableStream({
    async pull(controller) {
      if (closed) { try { controller.close(); } catch {} return; }
      try {
        const { done, value } = await reader.read();
        if (done) {
          closed = true;
          if (buf.trim()) {
            // 残余缓冲尝试处理
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        buf += decoder.decode(value, { stream: true });
        let out = "";
        // 按 \n\n 分事件
        while (true) {
          const sep = buf.indexOf("\n\n");
          if (sep < 0) break;
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const lines = raw.split("\n");
          let curEvent = evtType;
          let dataStr = "";
          for (const line of lines) {
            if (line.startsWith("event:")) curEvent = line.slice(6).trim();
            else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
          }
          if (!dataStr) { evtType = ""; continue; }
          evtType = "";
          let data;
          try { data = JSON.parse(dataStr); } catch { continue; }
          // 记录 id/model/created
          if (data.response?.id) respId = data.response.id;
          if (data.response?.model) respModel = data.response.model;
          if (data.response?.created_at) created = Math.floor(data.response.created_at);
          if (data.response?.id && !respId) respId = data.response.id;
          // 关注 output_text.delta
          if (curEvent === "response.output_text.delta" || data.type === "response.output_text.delta") {
            const deltaText = data.delta || "";
            if (deltaText) {
              if (!hasSentRole) {
                hasSentRole = true;
                out += chatChunk({ role: "assistant" }, null);
              }
              out += chatChunk({ content: deltaText }, null);
            }
          } else if (curEvent === "response.completed" || data.type === "response.completed") {
            const usage = data.response?.usage || null;
            const finish = data.response?.status === "completed" ? "stop" : null;
            // 末帧带 usage
            const id = respId || `resp_${Date.now()}`;
            const payload = {
              id,
              object: "chat.completion.chunk",
              created,
              model: respModel,
              choices: [{ index: 0, delta: {}, finish_reason: finish }],
              usage: usage || undefined,
            };
            out += `data: ${JSON.stringify(payload)}\n\n`;
          } else if (data.type === "response.output_item.added" && data.item?.type === "message") {
            // message 开始，可发送 role
            if (!hasSentRole) {
              hasSentRole = true;
              out += chatChunk({ role: "assistant" }, null);
            }
          }
          // reasoning 加密块忽略
        }
        if (out) controller.enqueue(encoder.encode(out));
      } catch {
        closed = true;
        try { controller.close(); } catch {}
      }
    },
    cancel() {
      closed = true;
      try { reader.cancel(); } catch {}
    },
  });
  const headers = new Headers(res.headers);
  headers.set("content-type", "text/event-stream");
  const out = new Response(body, { status: res.status, statusText: res.statusText, headers });
  try { out._t = res._t; } catch {}
  return out;
}
