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

  // gateway totals — 来自 -d 进程的持久化日志（非本 -chat 会话）
  const cf = callsFile();
  const ef = errorsFile();
  const totalCalls = readLinesCount(cf);
  const totalErrs = readLinesCount(ef);
  const recent = recentCalls(5);
  const lastErr = lastError();

  // cache model counts + ids
  let freeCount = 0;
  let cachedAt = null;
  let freeIds = [];
  try {
    const cacheFile = `${logDir()}/models.json`;
    if (existsSync(cacheFile)) {
      const j = JSON.parse(readFileSync(cacheFile, "utf8"));
      if (Array.isArray(j.data)) {
        freeIds = j.data.map((m) => m.id).filter(Boolean);
        freeCount = freeIds.length;
      }
      cachedAt = j.cachedAt || null;
    }
  } catch {}
  const freeSet = new Set(freeIds);

  // per-model daemon detail (for /stats) — 只展示网关认识的 free 模型，避免测试假数据污染
  const allIds = Object.keys({ ...latencies, ...errors }).filter(Boolean);
  const filteredIds = freeIds.length
    ? allIds.filter((id) => freeSet.has(id) || id === gatewayModel || id === CHAT_PREFERRED || id === CHAT_FALLBACK)
    : allIds.filter((id) => !/^m-(one|two)-free$|^a-free$|^b-free$|^c-free$|^ghost-/.test(id) && !id.startsWith("test-"));
  const perModel = filteredIds
    .map((id) => ({
      id,
      lat: latencies[id] || null,
      status: fmtStatus(errors[id]),
      at: errors[id]?.at || latencies[id]?.at || 0,
    }))
    .sort((a, b) => (b.lat?.count || 0) - (a.lat?.count || 0) || (b.at - a.at));

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
    latencies,
    errors,
    perModel,
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
  lines.push(`${cyan}┌─ mslxdff chat  ·  数据来自 -d 网关进程（非本会话） ─────${rst}`);
  lines.push(`${cyan}│${rst}  对话模型  ${yellow}${s.chatPref}${rst} ${dim}→ ${s.chatFall}（自动降级）${rst}  ${dim}[${s.chatPrefStatus}/${s.chatFallStatus}]${rst}`);
  lines.push(`${cyan}│${rst}  网关默认  ${green}${s.gatewayModel}${rst} ${dim}[${s.gatewayStatus}]${rst}  ·  端口 ${s.port}  ·  ${dim}${s.endpointUrl}${rst}`);
  const prefLine = `mimo ${fmtLatency(s.chatPrefLat)}`;
  const fallLine = `pickle ${fmtLatency(s.chatFallLat)}`;
  const gateLine = s.gatewayModel !== s.chatPref && s.gatewayModel !== s.chatFall ? ` · 网关默认 ${fmtLatency(s.gatewayLat)}` : "";
  lines.push(`${cyan}│${rst}  网关延迟 ${prefLine}  ·  ${fallLine}${gateLine}`);
  const errWhen = s.lastErr?.ts ? fmtShanghai(s.lastErr.ts) : "—";
  const errMsg = s.lastErr?.message ? String(s.lastErr.message).slice(0, 40) : (s.lastErr?.status ? `HTTP ${s.lastErr.status}` : "无");
  lines.push(`${cyan}│${rst}  网关请求  总 ${s.total}  成功 ${s.success}  失败 ${s.fail}  ${dim}· 末错 ${errWhen} ${errMsg}${rst}`);
  const cacheInfo = s.freeCount ? `${s.freeCount} free` : "—";
  const picksInfo = s.picks.length ? `${s.picks.length} 已选` : "未筛选";
  lines.push(`${cyan}│${rst}  模型库   ${cacheInfo}  ·  勾选 ${picksInfo}  ${dim}${s.picks.slice(0, 3).join(", ") || ""}${s.picks.length > 3 ? " …" : ""}${rst}`);
  lines.push(`${cyan}│${rst}  健康     ${dim}${s.healthUrl}${rst}  ${dim}· 日志 ${recentCalls(1).length ? "有" : "暂无"} · 上海时间${rst}`);
  lines.push(`${cyan}└──────────────────────────────────────────────────${rst}`);
  return { lines, stats: s };
}

export function formatStatsDetail() {
  const s = collectStats();
  const dim = "\x1b[90m";
  const rst = "\x1b[0m";
  const cyan = "\x1b[36m";
  const out = [];
  out.push(`${dim}── 网关详细统计（-d 进程持久化数据） ──────────${rst}`);
  out.push(`网关默认: ${s.gatewayModel} [${s.gatewayStatus}] 延迟 ${fmtLatency(s.gatewayLat)}  端口 ${s.port}`);
  out.push(`对话模型: ${s.chatPref} [${s.chatPrefStatus}] ${fmtLatency(s.chatPrefLat)}  ·  兜底 ${s.chatFall} [${s.chatFallStatus}] ${fmtLatency(s.chatFallLat)}`);
  out.push(`健康: ${s.healthUrl}  端点: ${s.endpointUrl}`);
  out.push(`网关请求: 总 ${s.total}  成功 ${s.success}  失败 ${s.fail}  ${dim}(calls.log + errors.log 持久化计数)${rst}`);
  if (s.lastErr) {
    out.push(`末次错误: ${fmtShanghai(s.lastErr.ts)}  ${s.lastErr.model || ""}  ${s.lastErr.status || ""}  ${String(s.lastErr.message || "").slice(0, 80)}`);
  } else {
    out.push(`末次错误: 无`);
  }
  out.push(`勾选集: ${s.picks.length ? s.picks.join(", ") : "(空=全量 auto)"}  ·  模型库: ${s.freeCount || 0} free  缓存: ${s.cachedAt ? fmtShanghai(s.cachedAt) : "—"}`);
  if (s.perModel.length) {
    out.push(`各模型网关统计（按成功次数排序）:`);
    for (const r of s.perModel.slice(0, 10)) {
      const lat = r.lat ? `${r.lat.emaMs}ms·${r.lat.count}次` : "—";
      const at = r.at ? fmtShanghai(r.at) : "—";
      out.push(`  ${r.id.padEnd(28)}  ${r.status.padEnd(6)}  ${lat.padEnd(16)}  ${at}`);
    }
    if (s.perModel.length > 10) out.push(`  … 还有 ${s.perModel.length - 10} 个模型`);
  }
  if (s.recent.length) {
    out.push(`最近网关调用（calls.log 最近5条）:`);
    for (const r of s.recent.slice(-5)) {
      out.push(`  ${fmtShanghai(r.ts)}  ${(r.model || "-").padEnd(22)}  ${String(r.status || "-").padEnd(4)}  ${r.durationMs ? r.durationMs + "ms" : ""} ${r.stream ? "stream" : ""}`);
    }
  }
  out.push(`${dim}提示：以上均为 -d 网关进程的持久化数据，非本 -chat 会话计数。看实时事件用 mslxdff -log 20${rst}`);
  out.push(`${dim}──────────────────────────────────────${rst}`);
  return out.join("\n");
}
