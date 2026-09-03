import { computeMetrics } from "../metrics.js";
import { createTransport } from "../transport/index.js";

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

function sseContent(obj) {
  const c = obj?.choices?.[0]?.delta?.content || obj?.choices?.[0]?.message?.content || "";
  return typeof c === "string" ? c : "";
}

export async function workbuddyBenchOne({ baseUrl, chatPath = "/v2/chat/completions", model, apiKey, auth, prompt = "hi", maxTokens = 5, timeoutMs = 30000, fetchImpl = globalThis.fetch }) {
  const tr = createTransport({ fetchImpl, keepAlive: false, retry: {}, timeoutMs });
  let ttfbMs = null;
  let totalMs = null;
  let content = "";
  try {
    const url = String(baseUrl).replace(/\/+$/, "") + String(chatPath || "/v2/chat/completions");
    const headers = buildWorkbuddyHeaders(apiKey, auth);
    const rawModel = String(model || "").trim();
    const body = { model: rawModel, stream: true, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens };
    const res = await tr.request({ url, method: "POST", headers, body, stream: true });
    if (!res.ok) {
      let txt = "";
      try { txt = await res.text(); } catch {}
      const label = res.status === 401 ? "鉴权失败" : res.status === 402 ? "余额不足" : res.status === 429 ? "限流" : res.status >= 500 ? `上游错误 ${res.status}` : `HTTP ${res.status}`;
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
