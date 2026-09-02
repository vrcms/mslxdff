import { computeMetrics } from "../metrics.js";

function buildWorkbuddyHeaders(apiKey, auth) {
  const h = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": "CLI/2.115.0 WorkBuddy/2.115.0",
    Origin: "https://www.codebuddy.cn",
    Referer: "https://www.codebuddy.cn/",
    "X-Product": "SaaS",
  };
  if (apiKey) h["Authorization"] = `Bearer ${apiKey}`;
  if (auth?.uid) h["X-User-Id"] = auth.uid;
  h["X-Domain"] = auth?.domain || "www.codebuddy.cn";
  if (auth?.enterpriseId) { h["X-Enterprise-Id"] = auth.enterpriseId; h["X-Tenant-Id"] = auth.enterpriseId; }
  return h;
}

export async function workbuddyBenchOne({ baseUrl, chatPath = "/v2/chat/completions", model, apiKey, auth, prompt = "hi", maxTokens = 5, timeoutMs = 30000, fetchImpl = globalThis.fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);
  const t0 = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  let ttfbMs = null;
  let content = "";
  try {
    const url = String(baseUrl).replace(/\/+$/, "") + String(chatPath || "/v2/chat/completions");
    const headers = buildWorkbuddyHeaders(apiKey, auth);
    const rawModel = String(model || "").trim();
    const body = { model: rawModel, stream: true, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens };
    const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    if (res instanceof Error) throw res;
    if (!res.ok) {
      let txt = "";
      try { txt = await res.text(); } catch {}
      const label = res.status === 401 ? "鉴权失败" : res.status === 402 ? "余额不足" : res.status === 429 ? "限流" : res.status >= 500 ? `上游错误 ${res.status}` : `HTTP ${res.status}`;
      return { id: model, ok: false, status: res.status, label, error: txt.slice(0, 300), ttfbMs, totalMs: Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()) - t0), tps: null, charsPerSec: null, tokens: null };
    }
    // SSE stream parsing — 复用 cline 逻辑
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (ttfbMs === null) ttfbMs = Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()) - t0);
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
    const totalMs = Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()) - t0);
    const chars = content.length;
    const { tps, charsPerSec } = computeMetrics({ ttfbMs, totalMs, promptTokens: null, completionTokens: null, chars });
    return { id: model, ok: true, status: 200, label: "成功", ttfbMs, totalMs, tps, charsPerSec, tokens: null, chars };
  } catch (e) {
    const msg = e?.message || String(e);
    const totalMs = Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()) - t0);
    return { id: model, ok: false, label: /timeout|abort/i.test(msg) ? "超时" : "网络错误", error: msg.slice(0, 300), ttfbMs, totalMs, tps: null, charsPerSec: null, tokens: null };
  } finally { clearTimeout(timer); }
}
