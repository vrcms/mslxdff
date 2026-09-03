import { joinUrl } from "../providers/base.js";
import { computeMetrics, extractUsageFromJson } from "../metrics.js";
import { createTransport } from "../transport/index.js";

function extractInnerMessage(bodyText) {
  const t = String(bodyText || "");
  try {
    const j = JSON.parse(t);
    const m = j?.error?.message || j?.error || j?.message || j?.data?.error || "";
    if (typeof m === "string" && m.trim()) return m.trim().slice(0, 300);
    if (typeof j?.error === "string") return j.error.slice(0, 300);
  } catch {}
  return t.slice(0, 300);
}

function classifyError(status, bodyText) {
  const t = String(bodyText || "").slice(0, 500);
  const low = t.toLowerCase();
  if (status === 401) return { label: "鉴权失败", retryable: false };
  if (status === 402 || /insufficient balance/i.test(t)) return { label: "余额不足", retryable: false };
  if (low.includes("only available via cline")) return { label: "仅 Cline 客户端可用", retryable: false };
  if (low.includes("invalid model format")) return { label: "模型格式错误", retryable: false };
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
} = {}) {
  if (!baseUrl) return { id: model, ok: false, error: "missing baseUrl", label: "配置错误", ttfbMs: null, totalMs: 0, tps: null, charsPerSec: null, tokens: null };
  if (!model) return { id: model, ok: false, error: "missing model", label: "配置错误", ttfbMs: null, totalMs: 0, tps: null, charsPerSec: null, tokens: null };
  if (!apiKey) return { id: model, ok: false, error: "missing apiKey", label: "未配置 Key", ttfbMs: null, totalMs: 0, tps: null, charsPerSec: null, tokens: null };
  const url = joinUrl(String(baseUrl).replace(/\/+$/, ""), chatPath);
  let rawModel = String(model || "").trim();
  if (providerId && rawModel.startsWith(`${providerId}/`)) rawModel = rawModel.slice(providerId.length + 1);
  const body = { model: rawModel, stream: false, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens };
  const finalHeaders = { "Content-Type": "application/json", Accept: "application/json", ...headers };
  if (apiKey && !finalHeaders.Authorization) finalHeaders.Authorization = `Bearer ${apiKey}`;
  const tr = createTransport({ fetchImpl, keepAlive: false, retry: {}, timeoutMs });
  try {
    const res = await tr.request({ url, method: "POST", headers: finalHeaders, body, stream: false });
    const ttfbMs = res.ttfbMs;
    const totalMs = res.totalMs;
    if (!res.ok) {
      let txt = ""; try { txt = await res.text(); } catch {}
      const cls = classifyError(res.status, txt);
      const msg = extractInnerMessage(txt) || `HTTP ${res.status}`;
      return { id: model, providerId, ok: false, status: res.status, error: msg, label: cls.label, ttfbMs, totalMs, tps: null, charsPerSec: null, tokens: null };
    }
    let json = {}; let txt = "";
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
    const msg = e?.message || String(e);
    const isTimeout = /timeout|abort/i.test(msg);
    return { id: model, providerId, ok: false, error: msg.slice(0, 300), label: isTimeout ? "超时" : "网络错误", ttfbMs: null, totalMs: null, tps: null, charsPerSec: null, tokens: null };
  }
}
