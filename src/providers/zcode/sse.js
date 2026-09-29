// Anthropic SSE → OpenAI 形状转换（流式 / 聚合两种出口）。
// 承诺字段：文本增量、tool_use 增量（tool_calls）、usage、finish_reason；thinking 块丢弃（不入历史）。
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
const STOP_REASONS = { end_turn: "stop", max_tokens: "length", tool_use: "tool_calls", stop_sequence: "stop", pause_turn: "stop" };
const newId = () => `chatcmpl-zcode-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

function dataPayload(block) {
  const lines = String(block || "").split("\n").filter((l) => l.startsWith("data:"));
  if (!lines.length) return null;
  const joined = lines.map((l) => l.slice(5).trimStart()).join("\n").trim();
  if (!joined || joined === "[DONE]") return null;
  try {
    return JSON.parse(joined);
  } catch {
    return null;
  }
}

export function createAnthropicTranslator({ model = "zcode", id = newId(), created = Math.floor(Date.now() / 1000) } = {}) {
  let buffer = "";
  let roleSent = false;
  let tailSent = false;
  let stopReason = null;
  let error = null;
  let inputTokens = null;
  let outputTokens = null;
  let text = "";
  let toolCount = 0;
  const toolIndexByBlock = new Map();
  const toolCalls = [];

  const usage = () => {
    if (inputTokens == null && outputTokens == null) return undefined;
    const prompt = inputTokens ?? 0;
    const completion = outputTokens ?? 0;
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
  };

  const chunkLine = (delta, finish = null, u) => {
    const chunk = { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] };
    if (u) chunk.usage = u;
    return `data: ${JSON.stringify(chunk)}\n\n`;
  };

  function handle(evt) {
    const out = [];
    if (!evt || typeof evt !== "object") return out;
    if (evt.type === "message_start") {
      const it = evt.message?.usage?.input_tokens ?? evt.usage?.input_tokens;
      if (it != null) inputTokens = Number(it) || 0;
      if (!roleSent) {
        roleSent = true;
        out.push(chunkLine({ role: "assistant", content: "" }));
      }
    } else if (evt.type === "content_block_start") {
      const block = evt.content_block || {};
      if (block.type === "tool_use") {
        const idx = toolCount++;
        toolIndexByBlock.set(Number(evt.index), idx);
        toolCalls.push({ id: String(block.id || `toolu_${idx}`), name: String(block.name || ""), args: "" });
        out.push(chunkLine({ tool_calls: [{ index: idx, id: String(block.id || ""), type: "function", function: { name: String(block.name || ""), arguments: "" } }] }));
      }
    } else if (evt.type === "content_block_delta") {
      const d = evt.delta || {};
      if (d.type === "text_delta" && typeof d.text === "string") {
        text += d.text;
        out.push(chunkLine({ content: d.text }));
      } else if (d.type === "input_json_delta" && typeof d.partial_json === "string") {
        const idx = toolIndexByBlock.has(Number(evt.index)) ? toolIndexByBlock.get(Number(evt.index)) : Math.max(0, toolCount - 1);
        if (toolCalls[idx]) toolCalls[idx].args += d.partial_json;
        out.push(chunkLine({ tool_calls: [{ index: idx, function: { arguments: d.partial_json } }] }));
      }
    } else if (evt.type === "message_delta") {
      const r = evt.delta?.stop_reason;
      if (r) stopReason = STOP_REASONS[r] || "stop";
      if (evt.usage?.output_tokens != null) outputTokens = Number(evt.usage.output_tokens) || 0;
    } else if (evt.type === "message_stop") {
      out.push(chunkLine({}, stopReason || "stop", usage()));
      out.push("data: [DONE]\n\n");
      tailSent = true;
    } else if (evt.type === "error") {
      error = { kind: "server", code: 0, message: String(evt.error?.message || "上游流内错误") };
      out.push(`data: ${JSON.stringify({ error: { message: error.message, type: String(evt.error?.type || "upstream_error") } })}\n\n`);
      out.push("data: [DONE]\n\n");
      tailSent = true;
    }
    return out;
  }

  function feed(textChunk) {
    buffer += String(textChunk ?? "").replace(/\r\n/g, "\n");
    const out = [];
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const payload = dataPayload(block);
      if (payload) out.push(...handle(payload));
    }
    return out;
  }

  function flush() {
    if (tailSent) return [];
    tailSent = true;
    const out = [];
    if (!roleSent) out.push(chunkLine({ role: "assistant", content: "" }));
    out.push(chunkLine({}, stopReason || "stop", usage()));
    out.push("data: [DONE]\n\n");
    return out;
  }

  function result() {
    const message = { role: "assistant", content: text || null };
    if (toolCalls.length) {
      message.tool_calls = toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.args || "{}" } }));
      if (!text) message.content = null;
    }
    return {
      error,
      openAi: {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message, finish_reason: stopReason || "stop" }],
        usage: usage() || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      },
    };
  }

  return { feed, flush, result };
}

export function anthropicToOpenAiStream(upstream, options = {}) {
  const translator = createAnthropicTranslator(options);
  if (!upstream || typeof upstream.getReader !== "function") {
    return new ReadableStream({
      start(controller) {
        for (const s of [...translator.feed(String(upstream ?? "")), ...translator.flush()]) controller.enqueue(ENCODER.encode(s));
        controller.close();
      },
    });
  }
  const reader = upstream.getReader();
  return new ReadableStream({
    async pull(controller) {
      // 注意：pull 必须「有产出或收流」才返回——若本次不 enqueue，流规范不会再触发下一次 pull，
      // 消费端 read() 会永久挂起（首个分片落在事件中间时必现）。故此处循环读到有产出为止。
      for (;;) {
        let next;
        try {
          next = await reader.read();
        } catch {
          next = { done: true };
        }
        if (next?.done) {
          for (const s of translator.flush()) controller.enqueue(ENCODER.encode(s));
          controller.close();
          return;
        }
        const t = DECODER.decode(next.value, { stream: true });
        const out = translator.feed(t);
        if (out.length) {
          for (const s of out) controller.enqueue(ENCODER.encode(s));
          return;
        }
      }
    },
  });
}

export async function aggregateAnthropicToOpenAi(sseText, options = {}) {
  const translator = createAnthropicTranslator(options);
  translator.feed(String(sseText ?? ""));
  translator.flush();
  return translator.result();
}
