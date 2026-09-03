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

export async function viaProbe({
  peerUrl,
  token,
  providerId,
  model,
  prompt = "hi",
  maxTokens = 5,
  timeoutMs = 30000,
  fetchImpl = globalThis.fetch,
  clock = Date.now,
  shareKeys,
  shareKeysHeader,
  relayTarget,
  relayHeaders,
  relayBody,
  targetUrl,
} = {}) {
  const base = String(peerUrl || "").replace(/\/+$/, "");
  if (!base) return { ok: false, label: "配置错误", error: "missing peerUrl", ttfbMs: null, totalMs: 0, tps: null, charsPerSec: null, tokens: null };
  const tr = createTransport({ fetchImpl, keepAlive: false, retry: {}, timeoutMs });
  const rt = String(relayTarget || targetUrl || "").trim();
  if (rt) {
    const rh = relayHeaders && typeof relayHeaders === "object" ? relayHeaders : {};
    const rb = relayBody !== undefined ? relayBody : null;
    const relayUrl = joinUrl(base, "/v1/relay");
    const relayHeadersOut = { "Content-Type": "application/json", Accept: "application/json" };
    if (token) relayHeadersOut.Authorization = `Bearer ${token}`;
    const payload = { targetUrl: rt, method: "POST", headers: rh, body: rb };
    try {
      const res = await tr.request({ url: relayUrl, method: "POST", headers: relayHeadersOut, body: payload, stream: false });
      const ttfbMs = res.ttfbMs;
      const totalMs = res.totalMs;
      if (!res.ok) {
        let txt = ""; try { txt = await res.text(); } catch {}
        const cls = classifyError(res.status, txt);
        const msg = extractInnerMessage(txt) || `HTTP ${res.status}`;
        return { ok: false, status: res.status, label: cls.label, error: msg, ttfbMs, totalMs, tps: null, charsPerSec: null, tokens: null };
      }
      let txt = ""; let j = {};
      try { txt = await res.text(); j = JSON.parse(txt); } catch { j = {}; }
      const relayStatus = res.headers.get("x-mslxdff-relay-status") ? Number(res.headers.get("x-mslxdff-relay-status")) : res.status;
      if (relayStatus >= 400) {
        const cls = classifyError(relayStatus, txt);
        const msg = extractInnerMessage(txt) || `HTTP ${relayStatus}`;
        return { ok: false, status: relayStatus, label: cls.label, error: msg, ttfbMs, totalMs, tps: null, charsPerSec: null, tokens: null };
      }
      const usage = extractUsageFromJson(j);
      const content = j?.choices?.[0]?.message?.content || j?.choices?.[0]?.text || txt || "";
      const chars = typeof content === "string" ? content.length : 0;
      const pt = usage?.prompt_tokens ?? null;
      const ct = usage?.completion_tokens ?? null;
      const { tps, charsPerSec } = computeMetrics({ ttfbMs, totalMs, promptTokens: pt, completionTokens: ct, chars });
      const totalTokens = usage?.total_tokens ?? (pt !== null && ct !== null ? pt + ct : null);
      return { ok: true, status: relayStatus, label: "成功", ttfbMs, totalMs, tps, charsPerSec, tokens: { prompt: pt, completion: ct, total: totalTokens }, chars };
    } catch (e) {
      const msg = e?.message || String(e);
      const isTimeout = /timeout|abort/i.test(msg);
      return { ok: false, label: isTimeout ? "超时" : "网络错误", error: msg.slice(0, 300), ttfbMs: null, totalMs: null, tps: null, charsPerSec: null, tokens: null };
    }
  }
  if (!model) return { ok: false, label: "配置错误", error: "missing model", ttfbMs: null, totalMs: 0, tps: null, charsPerSec: null, tokens: null };
  let rawModel = String(model).trim();
  if (providerId && rawModel.startsWith(`${providerId}/`)) rawModel = rawModel.slice(providerId.length + 1);
  const url = joinUrl(base, "/v1/chat/completions");
  const body = { model: rawModel, stream: false, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens };
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const sk = shareKeysHeader || shareKeys;
  if (sk) headers["x-mslxdff-share-keys"] = String(sk);
  try {
    const res = await tr.request({ url, method: "POST", headers, body, stream: false });
    const ttfbMs = res.ttfbMs;
    const totalMs = res.totalMs;
    if (!res.ok) {
      let txt = ""; try { txt = await res.text(); } catch {}
      const cls = classifyError(res.status, txt);
      const msg = extractInnerMessage(txt) || `HTTP ${res.status}`;
      return { ok: false, status: res.status, label: cls.label, error: msg, ttfbMs, totalMs, tps: null, charsPerSec: null, tokens: null };
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
    return { ok: true, status: res.status, label: "成功", ttfbMs, totalMs, tps, charsPerSec, tokens: { prompt: promptTokens, completion: completionTokens, total: totalTokens }, chars };
  } catch (e) {
    const msg = e?.message || String(e);
    const isTimeout = /timeout|abort/i.test(msg);
    return { ok: false, label: isTimeout ? "超时" : "网络错误", error: msg.slice(0, 300), ttfbMs: null, totalMs: null, tps: null, charsPerSec: null, tokens: null };
  }
}
