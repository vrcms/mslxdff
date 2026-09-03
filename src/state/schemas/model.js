import { defaultStateFile, readState, writeStateImmediate, writeStateDeferred } from "../store.js";

export function loadModelErrors({ file = defaultStateFile() } = {}) {
  const errors = readState(file).modelErrors;
  return errors && typeof errors === "object" && !Array.isArray(errors) ? errors : {};
}

export function saveModelErrors(errors, { file = defaultStateFile() } = {}) {
  writeStateDeferred(file, { modelErrors: errors });
  return errors;
}

export function loadModelLatencies({ file = defaultStateFile() } = {}) {
  const lat = readState(file).modelLatencies;
  return lat && typeof lat === "object" && !Array.isArray(lat) ? lat : {};
}

export function saveModelLatencies(latencies, { file = defaultStateFile() } = {}) {
  writeStateDeferred(file, { modelLatencies: latencies });
  return latencies;
}

export function loadModelStats({ file = defaultStateFile() } = {}) {
  const s = readState(file).modelStats;
  return s && typeof s === "object" && !Array.isArray(s) ? s : {};
}

export function saveModelStats(stats, { file = defaultStateFile() } = {}) {
  writeStateDeferred(file, { modelStats: stats });
  return stats;
}

const STATS_ALPHA = 0.3;
function ema(prev, next) {
  if (!Number.isFinite(prev) || prev <= 0) return Math.round(next);
  if (!Number.isFinite(next) || next <= 0) return Math.round(prev);
  return Math.round(prev * (1 - STATS_ALPHA) + next * STATS_ALPHA);
}

export function recordModelStats(id, { ttfbMs, totalMs, tps, completionTokens, file = defaultStateFile() } = {}) {
  if (!id || typeof id !== "string") return null;
  const stats = loadModelStats({ file });
  const cur = stats[id] || { count: 0 };
  const next = { ...cur };
  next.count = (cur.count || 0) + 1;
  next.lastAt = Date.now();
  if (Number.isFinite(ttfbMs) && ttfbMs >= 0) {
    next.avgTtfbMs = cur.avgTtfbMs != null ? ema(cur.avgTtfbMs, ttfbMs) : Math.round(ttfbMs);
    next.emaTtfbMs = next.avgTtfbMs;
    // 简易 p95：取 max 的 EMA
    if (cur.p95Ttfb == null) next.p95Ttfb = Math.round(ttfbMs);
    else next.p95Ttfb = Math.max(cur.p95Ttfb, Math.round(ttfbMs * 0.7 + cur.p95Ttfb * 0.3));
  }
  if (Number.isFinite(totalMs) && totalMs >= 0) {
    next.avgTotalMs = cur.avgTotalMs != null ? ema(cur.avgTotalMs, totalMs) : Math.round(totalMs);
    next.emaTotalMs = next.avgTotalMs;
    next.lastTotalMs = Math.round(totalMs);
  }
  if (Number.isFinite(tps) && tps > 0) {
    next.avgTps = cur.avgTps != null ? Number((cur.avgTps * (1 - STATS_ALPHA) + tps * STATS_ALPHA).toFixed(1)) : Number(tps.toFixed(1));
    next.emaTps = next.avgTps;
  }
  if (Number.isFinite(completionTokens) && completionTokens > 0) {
    const prevAvg = cur.avgCompTok;
    next.avgCompTok = prevAvg != null ? Math.round(prevAvg * (1 - STATS_ALPHA) + completionTokens * STATS_ALPHA) : Math.round(completionTokens);
  }
  // 兼容旧字段：lastAt 供排序
  stats[id] = next;
  // 监控需实时可见，用同步落盘而非 500ms  debounce
  try { writeStateImmediate(file, { modelStats: stats }); } catch { saveModelStats(stats, { file }); }
  return next;
}

export function loadPreferredModel({ file = defaultStateFile() } = {}) {
  const v = readState(file).preferredModel;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function loadModelPicks({ file = defaultStateFile() } = {}) {
  const picks = readState(file).modelPicks;
  if (!Array.isArray(picks)) return [];
  return [...new Set(picks.filter((x) => typeof x === "string" && x.trim().length))];
}

export function saveModelPicks(picks, { file = defaultStateFile() } = {}) {
  const list = [...new Set((Array.isArray(picks) ? picks : []).filter((x) => typeof x === "string" && x.trim().length))];
  writeStateImmediate(file, { modelPicks: list });
  return list;
}

export function savePreferredModel(id, { file = defaultStateFile() } = {}) {
  writeStateImmediate(file, { preferredModel: String(id || "").trim() });
  return String(id || "").trim();
}
