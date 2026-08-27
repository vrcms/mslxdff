import { readFileSync, existsSync } from "node:fs";
import { getPreferredModel } from "../auto.js";
import { loadModelLatencies, loadModelErrors, loadModelPicks, getPort } from "../state.js";
import { logDir, callsFile, errorsFile, recentCalls, lastError } from "../logs.js";
import { fmtShanghai } from "../time.js";
import { CHAT_PREFERRED, CHAT_FALLBACK } from "./config.js";

function readLinesCount(file) {
  try {
    if (!existsSync(file)) return 0;
    const txt = readFileSync(file, "utf8");
    if (!txt.trim()) return 0;
    return txt.split("\n").filter(Boolean).length;
  } catch { return 0; }
}

function fmtLatency(entry) {
  if (!entry || !entry.emaMs) return "—";
  const ema = entry.emaMs;
  const cnt = entry.count ? ` · ${entry.count}次` : "";
  const last = entry.lastMs ? ` (末次 ${entry.lastMs}ms)` : "";
  return `${ema}ms${cnt}${last}`;
}

function fmtStatus(entry) {
  if (!entry) return "normal";
  if (typeof entry === "number") return "error";
  return entry.status || "normal";
}

export function collectStats() {
  const gatewayModel = getPreferredModel();
  const latencies = loadModelLatencies();
  const errors = loadModelErrors();
  const picks = loadModelPicks();
  const port = getPort() ?? (Number(process.env.MSLXDFF_PORT) > 0 ? Number(process.env.MSLXDFF_PORT) : 8989);
  const chatPrefLat = latencies[CHAT_PREFERRED] || null;
  const chatFallLat = latencies[CHAT_FALLBACK] || null;
  const gatewayLat = latencies[gatewayModel] || null;

  // gateway totals
  const cf = callsFile();
  const ef = errorsFile();
  const totalCalls = readLinesCount(cf);
  const totalErrs = readLinesCount(ef);
  // success approximated as calls with 2xx; we count all calls as attempts, errors as fails
  // For quick display, total = calls+errors, success = calls, fail = errors
  const recent = recentCalls(5);
  const lastErr = lastError();

  // cache model counts
  let freeCount = 0;
  let cachedAt = null;
  try {
    const cacheFile = `${logDir()}/models.json`;
    if (existsSync(cacheFile)) {
      const j = JSON.parse(readFileSync(cacheFile, "utf8"));
      if (Array.isArray(j.data)) freeCount = j.data.length;
      cachedAt = j.cachedAt || null;
    }
  } catch {}

  return {
    gatewayModel,
    gatewayLat,
    chatPref: CHAT_PREFERRED,
    chatFall: CHAT_FALLBACK,
    chatPrefLat,
    chatFallLat,
    chatPrefStatus: fmtStatus(errors[CHAT_PREFERRED]),
    chatFallStatus: fmtStatus(errors[CHAT_FALLBACK]),
    gatewayStatus: fmtStatus(errors[gatewayModel]),
    picks,
    port,
    totalCalls,
    totalErrs,
    total: totalCalls + totalErrs,
    success: totalCalls,
    fail: totalErrs,
    recent,
    lastErr,
    freeCount,
    cachedAt,
    healthUrl: `http://127.0.0.1:${port}/health`,
    endpointUrl: `http://127.0.0.1:${port}/v1`,
  };
}

export function formatBannerLines() {
  const s = collectStats();
  const dim = "\x1b[90m";
  const rst = "\x1b[0m";
  const cyan = "\x1b[36m";
  const yellow = "\x1b[33m";
  const green = "\x1b[32m";
  const lines = [];
  lines.push(`${cyan}┌─ mslxdff chat ─────────────────────────────────────${rst}`);
  lines.push(`${cyan}│${rst}  对话模型  ${yellow}${s.chatPref}${rst} ${dim}→ ${s.chatFall}（自动降级）${rst}  ${dim}[${s.chatPrefStatus}/${s.chatFallStatus}]${rst}`);
  lines.push(`${cyan}│${rst}  网关默认  ${green}${s.gatewayModel}${rst} ${dim}[${s.gatewayStatus}]${rst}  ·  端口 ${s.port}  ·  ${dim}${s.endpointUrl}${rst}`);
  const prefLine = `mimo ${fmtLatency(s.chatPrefLat)}`;
  const fallLine = `pickle ${fmtLatency(s.chatFallLat)}`;
  const gateLine = s.gatewayModel !== s.chatPref && s.gatewayModel !== s.chatFall ? ` · 网关 ${fmtLatency(s.gatewayLat)}` : "";
  lines.push(`${cyan}│${rst}  延迟     ${prefLine}  ·  ${fallLine}${gateLine}`);
  const errWhen = s.lastErr?.ts ? fmtShanghai(s.lastErr.ts) : "—";
  const errMsg = s.lastErr?.message ? String(s.lastErr.message).slice(0, 40) : (s.lastErr?.status ? `HTTP ${s.lastErr.status}` : "无");
  lines.push(`${cyan}│${rst}  网关统计  总 ${s.total}  成功 ${s.success}  失败 ${s.fail}  ${dim}· 末错 ${errWhen} ${errMsg}${rst}`);
  const cacheInfo = s.freeCount ? `${s.freeCount} free` : "—";
  const picksInfo = s.picks.length ? `${s.picks.length} 已选` : "未筛选";
  lines.push(`${cyan}│${rst}  模型库   ${cacheInfo}  ·  勾选 ${picksInfo}  ${dim}${s.picks.slice(0, 3).join(", ") || ""}${s.picks.length > 3 ? " …" : ""}${rst}`);
  lines.push(`${cyan}│${rst}  历史     ${dim}${s.healthUrl}${rst}  ${dim}· ${recentCalls(1).length ? "有调用记录" : "暂无调用"}${rst}`);
  lines.push(`${cyan}└──────────────────────────────────────────────────${rst}`);
  return { lines, stats: s };
}

export function formatStatsDetail() {
  const s = collectStats();
  const dim = "\x1b[90m";
  const rst = "\x1b[0m";
  const out = [];
  out.push(`${dim}── 详细统计 ──────────────────────────${rst}`);
  out.push(`对话模型: ${s.chatPref} [${s.chatPrefStatus}] 延迟 ${fmtLatency(s.chatPrefLat)}`);
  out.push(`兜底模型: ${s.chatFall} [${s.chatFallStatus}] 延迟 ${fmtLatency(s.chatFallLat)}`);
  out.push(`网关默认: ${s.gatewayModel} [${s.gatewayStatus}] 延迟 ${fmtLatency(s.gatewayLat)}`);
  out.push(`端口: ${s.port}  健康: ${s.healthUrl}  端点: ${s.endpointUrl}`);
  out.push(`请求: 总 ${s.total}  成功 ${s.success}  失败 ${s.fail}`);
  if (s.lastErr) {
    out.push(`末次错误: ${fmtShanghai(s.lastErr.ts)}  ${s.lastErr.model || ""}  ${s.lastErr.status || ""}  ${String(s.lastErr.message || "").slice(0, 80)}`);
  } else {
    out.push(`末次错误: 无`);
  }
  out.push(`勾选集: ${s.picks.length ? s.picks.join(", ") : "(空=全量 auto)"}`);
  out.push(`模型库: ${s.freeCount || 0}  缓存: ${s.cachedAt ? fmtShanghai(s.cachedAt) : "—"}`);
  if (s.recent.length) {
    out.push(`最近调用:`);
    for (const r of s.recent.slice(-5)) {
      out.push(`  ${fmtShanghai(r.ts)}  ${r.model || "-"}  ${r.status || "-"}  ${r.durationMs ? r.durationMs + "ms" : ""} ${r.stream ? "stream" : ""}`);
    }
  }
  out.push(`${dim}──────────────────────────────────────${rst}`);
  return out.join("\n");
}
