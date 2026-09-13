// ADR-0015 轮转调度：每 tick 探 1 家供应商（direct + 逐 peer relay），EMA 合并旧值后落 via-routes.json
// 复用 bench/via-routes.js 的表格式与读写；探针写 provider:<id> 键，getViaRoute 精确键优先、provider 级回退。
import { directProbe, relayViaProbe } from "./probe.js";
import { classifyProvider, emaMerge } from "../providers/classify.js";
import { saveViaRoutes, loadViaRoutes } from "../bench/via-routes.js";
import { errMsg } from "../cli/util.js";

export const PROBE_DELAY_MS = Number(process.env.MSLXDFF_BENCH_DELAY_MS || 120) || 0;

// 从 providerConfigs 收集探针目标：local-only(workbuddy)/quota-pool(opencode) 排除，无 baseUrl 跳过
export function probeTargetsFromState({ loadProviderConfigs, loadProviderKeys, loadProviderBaseUrl } = {}) {
  const out = [];
  const ids = new Set(Object.keys(loadProviderConfigs?.() || {}));
  for (const id of ids) {
    if (classifyProvider(id) !== "latency-compare") continue;
    const cfg = (loadProviderConfigs?.() || {})[id] || {};
    const baseUrl = String(loadProviderBaseUrl?.(id) || cfg.baseUrl || "").replace(/\/+$/, "");
    if (!baseUrl) continue;
    out.push({ id, baseUrl, modelsPath: cfg.modelsPath || "/models", key: (loadProviderKeys?.(id) || [])[0] || "" });
  }
  return out;
}

export function nextCursor(cursor, total) {
  if (!Number.isInteger(total) || total <= 0) return 0;
  const c = Number.isInteger(cursor) ? cursor : 0;
  return c + 1 >= total ? 0 : c + 1;
}

function peerLabel(p) {
  const raw = String(p?.url || "");
  if (!raw) return "";
  if (raw.includes("://")) {
    try { const u = new URL(raw); return `${u.hostname}${u.port ? `:${u.port}` : ""}`; } catch { return raw.slice(-16); }
  }
  return raw;
}

// 单 tick：探 targets[cursor] 一家；返回 { probed, skipped }
export async function rotateTick({
  targets,
  cursor = 0,
  peers,
  timeoutMs = 5000,
  delayMs = PROBE_DELAY_MS,
  evt = () => {},
  fetchImpl,
  clock = Date.now,
  sampleMs,
  file,
} = {}) {
  const list = Array.isArray(targets) ? targets : [];
  if (!list.length) return { probed: null, skipped: true };
  const idx = cursor % list.length;
  const target = list[idx];
  const peerList = (peers?.all?.() || []).filter((p) => p?.url && !String(p.url).startsWith("relay://"));
  if (!peerList.length) {
    evt("upstream-probe-skip", { provider: target.id, reason: "no peers" });
    return { probed: null, skipped: true };
  }
  const authHeader = target.key ? `Bearer ${target.key}` : "";
  const direct = await directProbe({ baseUrl: target.baseUrl, modelsPath: target.modelsPath, key: target.key, timeoutMs, fetchImpl, clock, sampleMs });
  const via = {};
  for (const p of peerList) {
    const label = peerLabel(p) || String(p.url);
    const r = await relayViaProbe({ peerUrl: p.url, peerToken: p.token || "", targetUrl: `${target.baseUrl}${target.modelsPath}`, authHeader, timeoutMs, fetchImpl, clock, sampleMs });
    via[label] = { ok: r.ok, ttfbMs: r.ok ? r.ttfbMs : null, totalMs: r.ok ? r.ttfbMs : null, label: r.ok ? null : r.label };
    if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
  }
  const prev = loadViaRoutes(file).routes?.[`provider:${target.id}`] || null;
  const fresh = prev?.at && Date.now() - Date.parse(prev.at) < 10 * 60_000 ? prev : null;
  const merged = mergeEntry({ prev: fresh, direct, via });
  const results = [{ model: `provider:${target.id}`, ...merged, provider: target.id }];
  try {
    saveViaRoutes(results, { file, meta: { probe: true } });
  } catch (e) {
    evt("upstream-probe-error", { provider: target.id, error: errMsg(e).slice(0, 120) });
    return { probed: target.id, skipped: false, error: errMsg(e) };
  }
  evt("upstream-probe", { provider: target.id, direct: direct.ok ? direct.ttfbMs : null, best: merged.best, peers: Object.keys(via).length });
  return { probed: target.id, skipped: false };
}

// best 计算 + EMA 合并（相对 direct：via 胜出记负 delta）
function mergeEntry({ prev, direct, via }) {
  const ema = (p, r) => emaMerge(p, r?.ok ? r.ttfbMs : null);
  const directOut = {
    ok: Boolean(direct?.ok),
    ttfbMs: direct?.ok ? ema(prev?.direct?.ttfbMs, direct) : null,
    totalMs: direct?.ok ? ema(prev?.direct?.totalMs ?? prev?.direct?.ttfbMs, direct) : null,
    label: direct?.ok ? null : (direct?.label || "offline"),
    error: direct?.ok ? null : (direct?.label || null),
  };
  const viaOut = {};
  for (const [k, v] of Object.entries(via || {})) {
    viaOut[k] = v.ok
      ? { ok: true, ttfbMs: ema(prev?.via?.[k]?.ttfbMs, v), totalMs: ema(prev?.via?.[k]?.totalMs ?? prev?.via?.[k]?.ttfbMs, v) }
      : { ok: false, ttfbMs: v.ttfbMs ?? null, totalMs: v.totalMs ?? null, label: v.label || "offline" };
  }
  const directMs = directOut.ok ? (directOut.ttfbMs ?? directOut.totalMs) : Infinity;
  let best = "direct";
  let bestMs = directMs;
  for (const [k, v] of Object.entries(viaOut)) {
    if (!v.ok) continue;
    const t = v.ttfbMs ?? v.totalMs;
    if (Number.isFinite(t) && t < bestMs) { bestMs = t; best = `via:${k}`; }
  }
  const deltaMs = best.startsWith("via:") && Number.isFinite(directMs) ? Math.round(bestMs - directMs) : null;
  return { best, direct: directOut, via: viaOut, deltaMs };
}
