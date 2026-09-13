// ADR-0015 探针薄层：direct GET 探针 + 组员 /v1/relay 代发探针
// 只测 GET <modelsPath>，不烧 token；组长侧计时。
import { errMsg } from "../cli/util.js";
import { compatFetch, timeoutSignal } from "../compat.js";

export const PROBE_TIMEOUT_MS = 5000;

export async function directProbe({ baseUrl, modelsPath = "/models", key = "", timeoutMs = PROBE_TIMEOUT_MS, fetchImpl = compatFetch, clock = Date.now, sampleMs } = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base) return { ok: false, label: "配置错误", error: "missing baseUrl", ttfbMs: null };
  const p = String(modelsPath || "/models");
  const url = `${base}${p.startsWith("/") ? p : `/${p}`}`;
  const t0 = sampleMs ? sampleMs() : clock();
  try {
    const headers = { Accept: "application/json" };
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await fetchImpl(url, { method: "GET", headers, signal: timeoutSignal(timeoutMs) });
    const ms = sampleMs ? sampleMs() - t0 : clock() - t0;
    const status = typeof res.status === "number" ? res.status : (res.ok ? 200 : 0);
    if (status >= 400) return { ok: false, label: `HTTP ${status}`, ttfbMs: null };
    return { ok: true, ttfbMs: Math.max(0, Math.round(ms)) };
  } catch (e) {
    return { ok: false, label: errMsg(e).slice(0, 60), ttfbMs: null };
  }
}

// 组员代发：POST <peer>/v1/relay { targetUrl, method:"GET", headers } → 组员 fetch 上游后原样回
export async function relayViaProbe({ peerUrl, peerToken = "", targetUrl, authHeader = "", timeoutMs = PROBE_TIMEOUT_MS, fetchImpl = compatFetch, clock = Date.now, sampleMs } = {}) {
  const peer = String(peerUrl || "").replace(/\/+$/, "");
  if (!peer || !targetUrl) return { ok: false, label: "配置错误", ttfbMs: null };
  const t0 = sampleMs ? sampleMs() : clock();
  try {
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (peerToken) headers.Authorization = `Bearer ${peerToken}`;
    const res = await fetchImpl(`${peer}/v1/relay`, {
      method: "POST",
      headers,
      body: JSON.stringify({ targetUrl, method: "GET", headers: authHeader ? { Authorization: authHeader } : {} }),
      signal: timeoutSignal(timeoutMs),
    });
    const ms = sampleMs ? sampleMs() - t0 : clock() - t0;
    const relayStatus = res.headers?.get?.("x-mslxdff-relay-status");
    const status = relayStatus != null ? Number(relayStatus) : (res.status ?? 0);
    if (status >= 400) return { ok: false, label: `HTTP ${status}`, ttfbMs: null };
    return { ok: true, ttfbMs: Math.max(0, Math.round(ms)) };
  } catch (e) {
    return { ok: false, label: errMsg(e).slice(0, 60), ttfbMs: null };
  }
}
