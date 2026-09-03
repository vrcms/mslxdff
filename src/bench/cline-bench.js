import { clineHeaders } from "../providers/cline/headers.js";
import { computeMetrics } from "../metrics.js";
import { createTransport } from "../transport/index.js";

function sseContent(obj) {
  const c = obj?.choices?.[0]?.delta?.content || obj?.choices?.[0]?.message?.content || "";
  return typeof c === "string" ? c : "";
}

export async function clineBenchOne({ baseUrl, model, accessToken, prompt, maxTokens, timeoutMs, fetchImpl }) {
  const tr = createTransport({ fetchImpl, keepAlive: false, retry: {}, timeoutMs });
  let ttfbMs = null;
  let totalMs = null;
  let content = "";
  try {
    const sid = `sess_bench_${Date.now()}`;
    const res = await tr.request({
      url: `${baseUrl}/api/v1/chat/completions`,
      method: "POST",
      headers: { ...clineHeaders(sid, accessToken), Accept: "text/event-stream" },
      body: { model, messages: [{ role: "user", content: prompt }], stream: true, max_tokens: maxTokens, session_id: sid, reasoning_effort: "high" },
      stream: true,
    });
    if (!res.ok) {
      let txt = "";
      try { txt = await res.text(); } catch {}
      const label = res.status === 401 ? "鉴权失败" : res.status === 429 ? "限流" : res.status >= 500 ? `上游错误 ${res.status}` : `HTTP ${res.status}`;
      return { id: model, ok: false, status: res.status, label, error: txt.slice(0, 300), ttfbMs, totalMs: res.totalMs, tps: null, charsPerSec: null, tokens: null };
    }
    for await (const ev of res.stream()) {
      try { content += sseContent(JSON.parse(ev)); } catch {}
    }
    ttfbMs = res.ttfbMs;
    totalMs = res.totalMs;
    const chars = content.length;
    const { tps, charsPerSec } = computeMetrics({ ttfbMs, totalMs, promptTokens: null, completionTokens: null, chars });
    return { id: model, ok: true, status: 200, label: "成功", ttfbMs, totalMs, tps, charsPerSec, tokens: null, chars };
  } catch (e) {
    const msg = e?.message || String(e);
    return { id: model, ok: false, label: /timeout|abort/i.test(msg) ? "超时" : "网络错误", error: msg.slice(0, 300), ttfbMs, totalMs, tps: null, charsPerSec: null, tokens: null };
  }
}
