// workbuddy 流式 reasoning_content 整形：上游思考模型（如 glm-5.3-flash）把思考过程一词一 chunk
// 地放进 delta.reasoning_content，客户端会把每个增量渲染成独立 "- Thought" 条目。
// 旧版：连续 reasoning 增量缓冲到首个 content/finish 才一次性 flush → 思考期 10~30s 界面完全无变化（用户看到 workbuddy 后台流量走但 opencode 界面卡住）
// 新版：增量聚合 + 阈值分片：缓冲 reasoning，达到 REASONING_CHUNK_SIZE（默认 100 字符）即分片 flush，
// 期间仅首个 role 帧透传保持 TTFB，其余纯 reasoning 空帧吞掉（之前会透传 800+ 空 role 帧）；
// 尾段不足阈值的在 content/finish/流结束时兜底 flush。恒空 reasoning（deepseek-v4-flash）零改写。
// 仅包 workbuddy 出口的 SSE 响应，不影响其他供应商与全局聚合器。

const REASONING_CHUNK_SIZE = 150;

export function reshapeWorkbuddySse(res) {
  try {
    const ct = res.headers?.get?.("content-type") || "";
    if (res.status !== 200 || !ct.includes("text/event-stream") || !res.body) return res;
  } catch { return res; }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  let reasoningBuf = "";
  let lastMeta = null;
  let closed = false;
  let hasSentRole = false;
  let lastFlushAt = Date.now();

  function flushReasoningInto(out) {
    if (!reasoningBuf) return;
    const meta = lastMeta || {};
    out.push(`data: ${JSON.stringify({
      id: meta.id || "chatcmpl-workbuddy-reshape",
      object: meta.object || "chat.completion.chunk",
      created: meta.created || Math.floor(Date.now() / 1000),
      model: meta.model || "",
      choices: [{ index: 0, delta: { reasoning_content: reasoningBuf }, finish_reason: null }],
    })}\n\n`);
    reasoningBuf = "";
    lastFlushAt = Date.now();
  }

  let blankStreak = false;
  // 处理一段完整行文本（以 \n 结尾），产出的行/帧推进 out（连续空行合并为单个事件分隔）
  function processInto(text, out) {
    for (const line of text.split("\n")) {
      if (!line) { if (!blankStreak) out.push("\n"); blankStreak = true; continue; }
      blankStreak = false;
      if (!line.startsWith("data:")) { out.push(line + "\n"); continue; }
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") { out.push(line + "\n"); continue; }
      let obj;
      try { obj = JSON.parse(payload); } catch { out.push(line + "\n"); continue; }
      const ch = obj.choices?.[0];
      if (ch && typeof ch === "object") {
        if (obj.id) lastMeta = { id: obj.id, model: obj.model, object: obj.object, created: obj.created };
        const d = ch.delta && typeof ch.delta === "object" ? ch.delta : null;
        const rc = d ? d.reasoning_content : undefined;
        if (typeof rc === "string" && rc) {
          reasoningBuf += rc;
          d.reasoning_content = "";
          const isBoundary = (typeof d.content === "string" && d.content) || !!ch.finish_reason;
          // 首个 reasoning 帧的 role 透传一次，保 TTFB；后续纯 reasoning 的 role 重复帧直接吞掉
          if (!hasSentRole && d.role !== undefined) {
            hasSentRole = true;
            const rm = lastMeta || obj;
            out.push(`data: ${JSON.stringify({
              id: rm.id || obj.id || "chatcmpl-workbuddy-reshape",
              object: rm.object || obj.object || "chat.completion.chunk",
              created: rm.created || obj.created || Math.floor(Date.now() / 1000),
              model: rm.model || obj.model || "",
              choices: [{ index: 0, delta: { role: d.role }, finish_reason: null }],
            })}\n\n`);
          } else if (d.role !== undefined) {
            // 后续重复 role 帧不再透传，避免 800+ 空帧洪泛
            // 标记已发送过，避免后续非 reasoning 帧再误判为首次
            hasSentRole = true;
          }
          // 阈值分片：攒够 100 字符即向前吐一块，期间界面可见增量而非全程静默
          // 时间阈值：若距上次 flush 已超 700ms 且已攒 20+ 字符，也吐一块（避免小尾巴长时间不更新）
          const now = Date.now();
          const shouldChunk = reasoningBuf.length >= REASONING_CHUNK_SIZE
            || (reasoningBuf.length >= 50 && now - lastFlushAt > 1500);
          if (shouldChunk) flushReasoningInto(out);
          if (isBoundary) {
            // 兜底：content/finish 前把剩余思考一次性吐出，再透传本帧
            flushReasoningInto(out);
            const hasPassthrough = isBoundary || (Array.isArray(d.tool_calls) && d.tool_calls.length);
            if (hasPassthrough) out.push(`data: ${JSON.stringify(obj)}\n\n`);
            continue;
          }
          // 纯 reasoning 碎片帧已缓冲/或已分片吐出，原空帧吞掉
          continue;
        }
        // 非 reasoning 帧：若有 content/finish 先兜底 flush
        if ((typeof d?.content === "string" && d.content) || ch.finish_reason) flushReasoningInto(out);
        if (!hasSentRole && d?.role !== undefined) {
          hasSentRole = true;
        } else if (hasSentRole && d?.role !== undefined) {
          // 去重：首个 role 后续重复 role 去掉，避免下游每帧都带 role
          try { const clone = JSON.parse(payload); delete clone.choices[0].delta.role; out.push(`data: ${JSON.stringify(clone)}\n\n`); continue; } catch { /* fallback透传 */ }
        }
      }
      out.push(line + "\n");
    }
  }

  const body = new ReadableStream({
    async pull(controller) {
      if (closed) { try { controller.close(); } catch {} return; }
      try {
        const { done, value } = await reader.read();
        if (done) {
          closed = true;
          const out = [];
          if (buf) { processInto(buf + "\n", out); buf = ""; }
          flushReasoningInto(out);
          if (out.length) controller.enqueue(encoder.encode(out.join("")));
          controller.close();
          return;
        }
        buf += decoder.decode(value, { stream: true });
        const idx = buf.lastIndexOf("\n");
        if (idx < 0) return;
        const complete = buf.slice(0, idx + 1);
        buf = buf.slice(idx + 1);
        const out = [];
        processInto(complete, out);
        if (out.length) controller.enqueue(encoder.encode(out.join("")));
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

  const out = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  try { out._t = res._t; } catch {}
  return out;
}
