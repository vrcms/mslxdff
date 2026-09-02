import { clineHeaders } from "../providers/cline/headers.js";
import { computeMetrics } from "../metrics.js";

export async function clineBenchOne({ baseUrl, model, accessToken, prompt, maxTokens, timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);
  const t0 = performance.now();
  let ttfbMs = null;
  let content = "";
  try {
    const res = await fetchImpl(`${baseUrl}/api/v1/chat/completions`, {
      method: "POST",
      headers: { ...clineHeaders(`sess_bench_${Date.now()}`, accessToken), Accept: "text/event-stream" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: true, max_tokens: maxTokens, session_id: `sess_bench_${Date.now()}`, reasoning_effort: "high" }),
      signal: controller.signal,
    });
    if (res instanceof Error) throw res;
    if (!res.ok) {
      let txt = "";
      try { txt = await res.text(); } catch {}
      const label = res.status === 401 ? "鉴权失败" : res.status === 429 ? "限流" : res.status >= 500 ? `上游错误 ${res.status}` : `HTTP ${res.status}`;
      return { id: model, ok: false, status: res.status, label, error: txt.slice(0, 300), ttfbMs, totalMs: Math.round(performance.now() - t0), tps: null, charsPerSec: null, tokens: null };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (ttfbMs === null) ttfbMs = Math.round(performance.now() - t0);
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          const c = j?.choices?.[0]?.delta?.content || j?.choices?.[0]?.message?.content || "";
          if (typeof c === "string") content += c;
        } catch {}
      }
    }
    const totalMs = Math.round(performance.now() - t0);
    const chars = content.length;
    const { tps, charsPerSec } = computeMetrics({ ttfbMs, totalMs, promptTokens: null, completionTokens: null, chars });
    return { id: model, ok: true, status: 200, label: "成功", ttfbMs, totalMs, tps, charsPerSec, tokens: null, chars };
  } catch (e) {
    const msg = e?.message || String(e);
    return { id: model, ok: false, label: /timeout|abort/i.test(msg) ? "超时" : "网络错误", error: msg.slice(0, 300), ttfbMs, totalMs: Math.round(performance.now() - t0), tps: null, charsPerSec: null, tokens: null };
  } finally { clearTimeout(timer); }
}
