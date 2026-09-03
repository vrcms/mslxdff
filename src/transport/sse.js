/**
 * SSE 行协议深模块 — 纯函数 + 流式
 * 负责 `data: / : / event: / [DONE]` 的解析与粘包 remain 处理
 */

export function parseSseChunk(buf) {
  const events = [];
  let remain = String(buf || "");
  // 按 \n\n 分帧，\r\n 也兼容
  // 保留最后一帧若不以 \n\n 结尾则为 remain
  const normalized = remain.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  // 最后一部分若原串不以 \n\n 结尾则为 remain
  const endsWithDelim = normalized.endsWith("\n\n") || normalized.endsWith("\n\r\n");
  // parts 最后一项在非结尾时为未完成帧
  const complete = endsWithDelim ? parts : parts.slice(0, -1);
  remain = endsWithDelim ? "" : parts[parts.length - 1] || "";
  for (const frame of complete) {
    if (!frame) continue; // 空帧
    const lines = frame.split("\n");
    const dataLines = [];
    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith(":")) continue; // 注释/keepalive
      if (line.startsWith("event:")) continue; // 事件类型忽略
      if (line.startsWith("data:")) {
        let v = line.slice(5);
        if (v.startsWith(" ")) v = v.slice(1);
        dataLines.push(v);
      }
    }
    if (dataLines.length === 0) continue;
    // 多行 data 按 \n 拼接（SSE 规范）
    const payload = dataLines.join("\n");
    // 空 data: 仍产生事件，由上层过滤；此处保留以便测试可见
    events.push(payload);
  }
  return { events, remain };
}

export function createSseParser() {
  let buf = "";
  return {
    push(chunk) {
      buf += String(chunk || "");
      const { events, remain } = parseSseChunk(buf);
      buf = remain;
      return events;
    },
    flush() {
      // 未形成完整帧的不发（避免半包误触发）
      if (!buf.trim()) { buf = ""; return []; }
      // 若残留包含完整 data: 行但缺结尾，不强行发
      return [];
    },
    getRemain() { return buf; },
  };
}

export async function* streamFromResponse(res) {
  if (!res || !res.body) return;
  const parser = createSseParser();
  const reader = res.body.getReader ? res.body.getReader() : null;
  const decoder = new TextDecoder();
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      const evs = parser.push(text);
      for (const e of evs) {
        if (e === "[DONE]") return;
        if (e === "") continue;
        yield e;
      }
    }
    // flush 残留
    const rest = parser.flush();
    for (const e of rest) {
      if (e === "[DONE]") return;
      if (e) yield e;
    }
  } else if (typeof res.text === "function") {
    // 回退：一次性 text
    const txt = await res.text();
    const evs = parser.push(txt);
    for (const e of evs) {
      if (e === "[DONE]") return;
      if (e === "") continue;
      yield e;
    }
  }
}
