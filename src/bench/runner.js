import { joinUrl } from "../providers/base.js";
import { computeMetrics, extractUsageFromJson } from "../metrics.js";

function classifyError(status, bodyText) {
  const t = String(bodyText || "").slice(0, 300);
  if (status === 401) return { label: "鉴权失败", retryable: false };
  if (status === 402 || /insufficient balance/i.test(t)) return { label: "余额不足", retryable: false };
  if (status === 403) return { label: /insufficient/i.test(t) ? "余额不足" : "鉴权失败", retryable: false };
  if (status === 429) return { label: "限流", retryable: true };
  if (status >= 500) return { label: `上游错误 ${status}`, retryable: true };
  if (status === 404) return { label: "模型不存在", retryable: false };
  return { label: `HTTP ${status}`, retryable: false };
}

export async function runOne({
  baseUrl,
  chatPath = "/v1/chat/completions",
  model,
  providerId,
  apiKey,
  headers = {},
  prompt = "hi",
  maxTokens = 32,
  timeoutMs = 30000,
  fetchImpl = globalThis.fetch,
  clock = Date.now,
} = {}) {
  const started = clock();
  const t0 = typeof performance !== "undefined" && performance.now ? performance.now() : started;
  if (!baseUrl) return { id: model, ok: false, error: "missing baseUrl", label: "配置错误", ttfbMs: null, totalMs: 0, tps: null, charsPerSec: null, tokens: null };
  if (!model) return { id: model, ok: false, error: "missing model", label: "配置错误", ttfbMs: null, totalMs: 0, tps: null, charsPerSec: null, tokens: null };
  if (!apiKey) return { id: model, ok: false, error: "missing apiKey", label: "未配置 Key", ttfbMs: null, totalMs: 0, tps: null, charsPerSec: null, tokens: null };
  const url = joinUrl(String(baseUrl).replace(/\/+$/, ""), chatPath);
  const body = { model: String(model).split("/").pop(), stream: false, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens };
  // workbuddy 需额外 workbuddy 透传头由调用方 headers 注入；此处直接透传
  const finalHeaders = { "Content-Type": "application/json", Accept: "application/json", ...headers };
  if (apiKey && !finalHeaders.Authorization) finalHeaders.Authorization = `Bearer ${apiKey}`;

  let ttfbMs = null;
  let res;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);
    const fetchStart = typeof performance !== "undefined" && performance.now ? performance.now() : clock();
    try {
      res = await fetchImpl(url, { method: "POST", headers: finalHeaders, body: JSON.stringify(body), signal: controller.signal });
    } finally { clearTimeout(timer); }
    ttfbMs = Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : clock()) - fetchStart);
    if (res instanceof Error) throw res;
    const totalMs = Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : clock()) - t0);
    if (!res.ok) {
      let txt = "";
      try { txt = await res.text(); } catch {}
      const cls = classifyError(res.status, txt);
      return { id: model, providerId, ok: false, status: res.status, error: txt.slice(0, 300) || `HTTP ${res.status}`, label: cls.label, ttfbMs, totalMs, tps: null, charsPerSec: null, tokens: null };
    }
    let json = {};
    let txt = "";
    try { txt = await res.text(); json = JSON.parse(txt); } catch { json = {}; }
    const usage = extractUsageFromJson(json);
    const content = json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || txt || "";
    const chars = typeof content === "string" ? content.length : 0;
    const promptTokens = usage?.prompt_tokens ?? null;
    const completionTokens = usage?.completion_tokens ?? null;
    const { tps, charsPerSec } = computeMetrics({ ttfbMs, totalMs, promptTokens, completionTokens, chars });
    const totalTokens = usage?.total_tokens ?? (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null);
    return { id: model, providerId, ok: true, status: res.status, ttfbMs, totalMs, tps, charsPerSec, tokens: { prompt: promptTokens, completion: completionTokens, total: totalTokens }, chars, label: "成功", raw: json };
  } catch (e) {
    const totalMs = Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : clock()) - t0);
    const msg = e?.message || String(e);
    const isTimeout = /timeout|abort/i.test(msg);
    return { id: model, providerId, ok: false, error: msg.slice(0, 300), label: isTimeout ? "超时" : "网络错误", ttfbMs, totalMs, tps: null, charsPerSec: null, tokens: null };
  }
}
