/**
 * responses 转换层 — 从 upstream.js 抽出的 muse-spark 专用形状转换。
 * chat ⇄ responses 互转纯函数，无网络、无副作用。
 */
// responses 判定索引（models.dev 模型级 provider.npm，启动时注入）：
// "@ai-sdk/openai" → responses 端点；未注入/未命中 → 前缀兜底（新模型早于 models.dev 刷新时仍可用）。
let responsesNpmIndex = null;

export function setResponsesNpmIndex(idx) {
  responsesNpmIndex = idx instanceof Map ? idx : null;
}

export function _resetResponsesNpmIndex() {
  responsesNpmIndex = null;
}

export function isResponsesModel(model) {
  const m = String(model || "").toLowerCase().trim();
  if (!m) return false;
  if (responsesNpmIndex) {
    const bare = m.replace(/^opencode\//, "");
    if (responsesNpmIndex.has(bare)) return responsesNpmIndex.get(bare) === "@ai-sdk/openai";
  }
  return m.startsWith("muse-spark");
}

export function chatToResponsesBody(chatBody) {
  const msgs = Array.isArray(chatBody?.messages) ? chatBody.messages : [];
  const system = msgs.filter((m) => m.role === "system").map((m) => String(m.content || "")).join("\n");
  const nonSystem = msgs.filter((m) => m.role !== "system");
  // 图片保留：content 数组里的 image_url / input_image 转 responses 规范的 input_image item
  // （data: base64 原样透传；此前整段拍平成纯文本 → 模型"看不到图"，2026-09-22 实测）。
  const imagesOf = (m) => Array.isArray(m.content)
    ? m.content.flatMap((x) => {
        if (!x || typeof x !== "object") return [];
        const url = x.type === "image_url" || x.type === "input_image" || x.image_url != null
          ? (typeof x.image_url === "string" ? x.image_url : x.image_url?.url)
          : null;
        return url ? [{ type: "input_image", image_url: url }] : [];
      })
    : [];
  const inputItems = nonSystem.map((m) => {
    const c = m.content;
    let text;
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) text = c.filter((x) => x && (x.type === "text" || x.type === "input_text")).map((x) => x.text || "").join("");
    else text = String(c ?? "");
    let base = `${m.role}: ${text}`;
    // 保留 tool_calls / tool 结果，避免多轮丢失
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const tcStr = m.tool_calls.map((tc) => `${tc.function?.name || "tool"}(${tc.function?.arguments || ""})`).join("; ");
      base += ` [tool_calls: ${tcStr}]`;
    }
    if (m.role === "tool" && m.tool_call_id) base += ` (call_id=${m.tool_call_id})`;
    const imgs = imagesOf(m);
    return { text: base, images: imgs };
  });
  const inputParts = inputItems.map((x) => x.text);
  const hasText = inputParts.some((t) => t.trim());
  const allImages = inputItems.flatMap((x) => x.images);
  // 有图时 input 必须用 item 数组（text + input_image 混排）；纯文本保持串形状（既有行为不变）
  const input = allImages.length
    ? inputItems.flatMap((x) => {
        const items = [];
        if (x.text.trim()) items.push({ type: "input_text", text: x.text });
        items.push(...x.images);
        return items;
      })
    : (inputParts.join("\n\n") || "hi");
  void hasText;
  // 流式意图透传：客户端要 SSE 就向上游要 SSE（reshapeResponsesSse 负责转回 chat SSE）。
  // 写死 stream:false 是历史折衷（当时聚合 JSON 直回），已由完整 SSE 转换取代。
  const out = { model: chatBody.model, input, stream: chatBody?.stream === true };
  if (system) out.instructions = system;
  // responses 的 tools 形状为平铺 {type,name,description,parameters}，而 chat 为 {type,function:{name,...}}
  if (Array.isArray(chatBody.tools) && chatBody.tools.length) {
    const mapped = chatBody.tools.map((t) => {
      if (!t || typeof t !== "object") return null;
      if (t.type === "function" && t.function && typeof t.function === "object") {
        const fn = t.function;
        // 去掉 responses 不支持的 strict 等字段，parameters 原样透传
        const nt = { type: "function", name: fn.name, description: fn.description || undefined, parameters: fn.parameters || undefined };
        // 清理 undefined
        Object.keys(nt).forEach((k) => nt[k] === undefined && delete nt[k]);
        return nt.name ? nt : null;
      }
      // 已是平铺形态或未知形态，透传但确保 name 存在，清理 strict
      if (t.name) {
        const { strict, ...rest } = t;
        return rest;
      }
      return null;
    }).filter(Boolean);
    if (mapped.length) out.tools = mapped;
  }
  if (chatBody.tool_choice) {
    const tc = chatBody.tool_choice;
    // responses 仅支持 "auto"（实测 required/named 均 400），一律归一为 auto
    if (typeof tc === "string") {
      out.tool_choice = tc === "auto" ? "auto" : "auto";
    } else if (tc && typeof tc === "object") {
      if (tc.type === "auto" || tc.type === "required") out.tool_choice = "auto";
      else if (tc.type === "function") out.tool_choice = "auto";
      else if (tc.type) out.tool_choice = "auto";
      else out.tool_choice = "auto";
    }
  }
  if (chatBody.temperature != null) out.temperature = chatBody.temperature;
  if (chatBody.max_tokens != null) out.max_output_tokens = chatBody.max_tokens;
  return out;
}

export function responsesToChatJson(respJson) {
  let text = "";
  const toolCalls = [];
  for (const item of respJson.output || []) {
    if (item.type === "message" && item.role === "assistant") {
      for (const c of item.content || []) {
        if (c.type === "output_text") text += c.text || "";
        else if (c.type === "text") text += c.text || "";
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id || item.id || `call_${toolCalls.length}`,
        type: "function",
        function: { name: item.name || "", arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || "") },
      });
    }
  }
  if (!text && toolCalls.length === 0) {
    for (const item of respJson.output || []) {
      if (item.type === "message") {
        const t = item.content?.[0]?.text;
        if (t) { text = t; break; }
      }
    }
  }
  const message = { role: "assistant", content: text };
  if (toolCalls.length) {
    message.tool_calls = toolCalls;
    // 有 tool_calls 时 content 可为 ""，finish_reason 应为 tool_calls
  }
  const finish = toolCalls.length ? "tool_calls" : (respJson.status === "completed" ? "stop" : "length");
  const chatJson = {
    id: respJson.id || `resp_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor((respJson.created_at || Date.now() / 1000)),
    model: respJson.model,
    choices: [{ index: 0, finish_reason: finish, message }],
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
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  let evtType = "";
  let respId = "";
  let respModel = fallbackModel || "";
  let created = Math.floor(Date.now() / 1000);
  let hasSentRole = false;
  const toolMap = new Map(); // output_index -> {idx, id, name}

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

  function sendRole(out) {
    if (!hasSentRole) {
      hasSentRole = true;
      out += chatChunk({ role: "assistant" }, null);
    }
    return out;
  }

  // TransformStream 泵：for await 直接驱动上游流，writer.write 背压回压。
  // （自建 ReadableStream 的 pull 调度在本机 daemon 下出现"pull resolve 后不再续拉"
  //   导致 muse SSE 卡死；async-iterator 泵是 undici 流已验证畅通的姿势）
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  (async () => {
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
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
          // created/in_progress 即发 role 帧：muse reasoning 阶段可达数十秒，
          // 尽早产出首帧避免 relay 的首块超时（25s）误杀
          if (data.type === "response.created" || data.type === "response.in_progress") {
            out = sendRole(out);
          }
          if (curEvent === "response.output_text.delta" || data.type === "response.output_text.delta") {
            const deltaText = data.delta || "";
            if (deltaText) {
              out = sendRole(out);
              out += chatChunk({ content: deltaText }, null);
            }
          } else if (curEvent === "response.completed" || data.type === "response.completed") {
            const usage = data.response?.usage || null;
            // 若有 tool_calls，finish 应为 tool_calls
            const hasTools = toolMap.size > 0;
            const finish = hasTools ? "tool_calls" : (data.response?.status === "completed" ? "stop" : null);
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
            out = sendRole(out);
          } else if (data.type === "response.output_item.added" && data.item?.type === "function_call") {
            const outIdx = Number(data.output_index ?? 1);
            const toolIdx = Math.max(0, outIdx - 1);
            const callId = data.item?.call_id || data.item?.id || "";
            const name = data.item?.name || "";
            toolMap.set(outIdx, { idx: toolIdx, id: callId, name });
            out = sendRole(out);
            const tc = { index: toolIdx, id: callId, type: "function", function: { name, arguments: "" } };
            // 清理空字符串，避免 undefined
            if (!callId) delete tc.id;
            if (!name) delete tc.function.name;
            out += chatChunk({ tool_calls: [tc] }, null);
          } else if (data.type === "response.function_call_arguments.delta") {
            const outIdx = Number(data.output_index ?? 1);
            const entry = toolMap.get(outIdx) || { idx: Math.max(0, outIdx - 1) };
            const deltaArgs = data.delta || "";
            if (deltaArgs) {
              out = sendRole(out);
              out += chatChunk({ tool_calls: [{ index: entry.idx, function: { arguments: deltaArgs } }] }, null);
            }
          } else if (data.type === "response.function_call_arguments.done") {
            // done 可能带全量，若未通过 delta 发送过则补发；已通过 delta 发送则忽略，避免重复
          } else if (data.type === "response.output_item.done" && data.item?.type === "function_call") {
            // 可忽略，已通过 added+delta 完整
          }
          // reasoning 加密块忽略
        }
        if (out) await writer.write(encoder.encode(out));
      }
      await writer.write(encoder.encode("data: [DONE]\n\n"));
      await writer.close();
    } catch (e) {
      try { await writer.abort(e instanceof Error ? e : new Error(String(e))); } catch { try { writer.close(); } catch {} }
    }
  })();
  const headers = new Headers(res.headers);
  headers.set("content-type", "text/event-stream");
  const out = new Response(readable, { status: res.status, statusText: res.statusText, headers });
  try { out._t = res._t; } catch {}
  return out;
}

