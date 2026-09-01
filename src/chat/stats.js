import { readFileSync, existsSync } from "node:fs";
import { getPreferredModel } from "../auto.js";
import { loadModelLatencies, loadModelErrors, loadModelPicks, getPort, loadModelStats } from "../state.js";
import { logDir, callsFile, errorsFile, recentCalls, lastError } from "../logs.js";
import { fmtShanghai } from "../time.js";
import { CHAT_PREFERRED, CHAT_FALLBACK } from "./config.js";
import { normalizeFullId } from "../providers/model-id.js";

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

function fmtMs(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v < 1000) return `${v}ms`;
  return `${(v / 1000).toFixed(1)}s`;
}

function fmtTps(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v} tok/s`;
}

function fmtStatus(entry) {
  if (!entry) return "normal";
  if (typeof entry === "number") return "error";
  return entry.status || "normal";
}

export function collectStats() {
  const gatewayModel = getPreferredModel();
  const latencies = loadModelLatencies();
  const modelStats = loadModelStats();
  const errors = loadModelErrors();
  const picks = loadModelPicks();
  const port = getPort() ?? (Number(process.env.MSLXDFF_PORT) > 0 ? Number(process.env.MSLXDFF_PORT) : 8989);
  const fullPref = normalizeFullId(CHAT_PREFERRED);
  const fullFall = normalizeFullId(CHAT_FALLBACK);
  const fullGate = normalizeFullId(gatewayModel);
  const chatPrefStat = modelStats[fullPref] || modelStats[CHAT_PREFERRED] || null;
  const chatFallStat = modelStats[fullFall] || modelStats[CHAT_FALLBACK] || null;
  const gatewayStat = modelStats[fullGate] || modelStats[gatewayModel] || null;
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

  // per-model daemon detail (for /stats) — 优先用 modelStats（全称），兼容旧 latencies
  const statIds = Object.keys(modelStats);
  const allIds = [...new Set([...Object.keys(latencies), ...Object.keys(errors), ...statIds])].filter(Boolean);
  const filteredIds = freeIds.length
    ? allIds.filter((id) => {
        const full = normalizeFullId(id);
        return freeSet.has(id) || freeSet.has(full) || id === gatewayModel || id === CHAT_PREFERRED || id === CHAT_FALLBACK || full === fullGate || full === fullPref || full === fullFall || statIds.includes(full);
      })
    : allIds.filter((id) => !/^m-(one|two)-free$|^a-free$|^b-free$|^c-free$|^ghost-/.test(id) && !id.startsWith("test-"));
  const perModel = filteredIds
    .map((id) => {
      const full = normalizeFullId(id);
      const st = modelStats[full] || modelStats[id] || null;
      const lat = latencies[id] || latencies[full] || null;
      return {
        id: st ? full : id,
        fullId: full,
        lat: lat || null,
        st: st || null,
        status: fmtStatus(errors[id] || errors[full]),
        at: st?.lastAt || errors[id]?.at || errors[full]?.at || lat?.at || 0,
        count: st?.count ?? lat?.count ?? 0,
      };
    })
    .sort((a, b) => (b.count - a.count) || (b.at - a.at));

  return {
    gatewayModel,
    gatewayLat,
    gatewayStat,
    chatPref: CHAT_PREFERRED,
    chatFall: CHAT_FALLBACK,
    chatPrefStat,
    chatFallStat,
    chatPrefLat,
    chatFallLat,
    chatPrefStatus: fmtStatus(errors[CHAT_PREFERRED] || errors[fullPref]),
    chatFallStatus: fmtStatus(errors[CHAT_FALLBACK] || errors[fullFall]),
    gatewayStatus: fmtStatus(errors[gatewayModel] || errors[fullGate]),
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
    modelStats,
    errors,
    perModel,
  };
}

export async function probeGateway(port, timeoutMs = 800) {
  const url = `http://127.0.0.1:${port}/health`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return { alive: r.ok, status: r.status, ms: 0 };
  } catch (e) {
    clearTimeout(t);
    const msg = String(e?.message || e);
    const isRefused = /ECONNREFUSED|Failed to fetch|fetch failed|ECONNRESET|abort/i.test(msg);
    return { alive: false, status: 0, error: msg, refused: isRefused };
  }
}

export function formatBannerLines(healthProbe = null) {
  const s = collectStats();
  const dim = "\x1b[90m";
  const rst = "\x1b[0m";
  const cyan = "\x1b[36m";
  const yellow = "\x1b[33m";
  const green = "\x1b[32m";
  const red = "\x1b[31m";
  const bgRed = "\x1b[41m\x1b[37m";
  const lines = [];
  lines.push(`${cyan}┌─ mslxdff chat  ·  数据来自 -d 网关进程（非本会话） ─────${rst}`);
  if (healthProbe && !healthProbe.alive) {
    lines.push(`${red}│  ✗ 本地服务没有启动无法使用auto模式，请mslxdff -d 启动  ·  ${s.healthUrl} 拒绝连接（${healthProbe.error?.slice(0,60) || "ECONNREFUSED"}）${rst}`);
    lines.push(`${red}│  → 先在另一终端执行: mslxdff -d  (或 mslxdff)  启动后回此窗口重试，期间仅 mimo/big-pickle 直连可用，auto 不可用${rst}`);
  }
  lines.push(`${cyan}│${rst}  对话模型  ${yellow}${s.chatPref}${rst} ${dim}→ ${s.chatFall} → gateway auto:8989${rst}  ${dim}[${s.chatPrefStatus}/${s.chatFallStatus}]${rst}  ${dim}三级兜底${rst}`);
  const gwAliveTag = healthProbe ? (healthProbe.alive ? `${green}● 运行中${rst}` : `${red}● 未运行${rst}`) : `${dim}…检测中${rst}`;
  lines.push(`${cyan}│${rst}  网关默认  ${green}${s.gatewayModel}${rst} ${dim}[${s.gatewayStatus}]${rst}  ·  端口 ${s.port} ${gwAliveTag}  ·  ${dim}${s.endpointUrl}${rst}`);
  const prefTtfb = s.chatPrefStat?.avgTtfbMs ?? s.chatPrefStat?.emaTtfbMs ?? s.chatPrefLat?.emaMs;
  const fallTtfb = s.chatFallStat?.avgTtfbMs ?? s.chatFallStat?.emaTtfbMs ?? s.chatFallLat?.emaMs;
  const gateTtfb = s.gatewayStat?.avgTtfbMs ?? s.gatewayStat?.emaTtfbMs ?? s.gatewayLat?.emaMs;
  const prefLine = `mimo ${prefTtfb ? fmtMs(prefTtfb) + (s.chatPrefStat?.count ? `·${s.chatPrefStat.count}次` : "") : fmtLatency(s.chatPrefLat)}${s.chatPrefStat?.avgTps ? `·${fmtTps(s.chatPrefStat.avgTps)}` : ""}`;
  const fallLine = `pickle ${fallTtfb ? fmtMs(fallTtfb) + (s.chatFallStat?.count ? `·${s.chatFallStat.count}次` : "") : fmtLatency(s.chatFallLat)}${s.chatFallStat?.avgTps ? `·${fmtTps(s.chatFallStat.avgTps)}` : ""}`;
  const gateLine = s.gatewayModel !== s.chatPref && s.gatewayModel !== s.chatFall ? ` · 网关默认 ${gateTtfb ? fmtMs(gateTtfb) : fmtLatency(s.gatewayLat)}` : "";
  lines.push(`${cyan}│${rst}  平均首字 ${prefLine}  ·  ${fallLine}${gateLine}`);
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
  const out = [];
  out.push(`${dim}── 网关详细统计（-d 进程持久化数据） ──────────${rst}`);
  const gateTtfb = s.gatewayStat ? fmtMs(s.gatewayStat.avgTtfbMs ?? s.gatewayStat.emaTtfbMs) : fmtLatency(s.gatewayLat);
  const prefTtfb = s.chatPrefStat ? fmtMs(s.chatPrefStat.avgTtfbMs ?? s.chatPrefStat.emaTtfbMs) : fmtLatency(s.chatPrefLat);
  const fallTtfb = s.chatFallStat ? fmtMs(s.chatFallStat.avgTtfbMs ?? s.chatFallStat.emaTtfbMs) : fmtLatency(s.chatFallLat);
  out.push(`网关默认: ${s.gatewayModel} [${s.gatewayStatus}] 平均首字 ${gateTtfb}  端口 ${s.port}`);
  out.push(`对话模型: ${s.chatPref} [${s.chatPrefStatus}] ${prefTtfb}${s.chatPrefStat?.avgTps ? ` · ${fmtTps(s.chatPrefStat.avgTps)}` : ""}  ·  兜底 ${s.chatFall} [${s.chatFallStatus}] ${fallTtfb}${s.chatFallStat?.avgTps ? ` · ${fmtTps(s.chatFallStat.avgTps)}` : ""}`);
  out.push(`健康: ${s.healthUrl}  端点: ${s.endpointUrl}`);
  out.push(`网关请求: 总 ${s.total}  成功 ${s.success}  失败 ${s.fail}  ${dim}(calls.log + errors.log 持久化计数)${rst}`);
  if (s.lastErr) {
    out.push(`末次错误: ${fmtShanghai(s.lastErr.ts)}  ${s.lastErr.model || ""}  ${s.lastErr.status || ""}  ${String(s.lastErr.message || "").slice(0, 80)}`);
  } else {
    out.push(`末次错误: 无`);
  }
  out.push(`勾选集: ${s.picks.length ? s.picks.join(", ") : "(空=全量 auto)"}  ·  模型库: ${s.freeCount || 0} free  缓存: ${s.cachedAt ? fmtShanghai(s.cachedAt) : "—"}`);
  if (s.perModel.length) {
    out.push(`模型体检表（平均首字 / 平均总耗时 / 平均速度 / 啰嗦 / 样本，100次均值更稳）：`);
    out.push(`  ${"模型".padEnd(30)}  ${"首字".padEnd(8)}  ${"总耗时".padEnd(8)}  ${"速度".padEnd(12)}  ${"啰嗦".padEnd(8)}  ${"样本".padEnd(6)}  状态`);
    for (const r of s.perModel.slice(0, 15)) {
      const st = r.st;
      const ttfb = st ? fmtMs(st.avgTtfbMs ?? st.emaTtfbMs) : (r.lat ? fmtMs(r.lat.emaMs) : "—");
      const total = st ? fmtMs(st.avgTotalMs ?? st.emaTotalMs) : "—";
      const tps = st ? fmtTps(st.avgTps ?? st.emaTps) : "—";
      const verbose = st?.avgCompTok != null ? `${st.avgCompTok}tok` : "—";
      const cnt = st?.count ?? r.lat?.count ?? 0;
      const p95 = st?.p95Ttfb ? ` p95:${fmtMs(st.p95Ttfb)}` : "";
      const line = `  ${r.id.padEnd(30)}  ${ttfb.padEnd(8)}  ${total.padEnd(8)}  ${tps.padEnd(12)}  ${verbose.padEnd(8)}  ${String(cnt).padEnd(6)}  ${r.status}${p95}`;
      out.push(line);
    }
    if (s.perModel.length > 15) out.push(`  … 还有 ${s.perModel.length - 15} 个模型`);
    if (!s.perModel.some((r) => r.st)) out.push(`  ${dim}暂无新样本（新观测需发一次请求后出现），旧数据仅显示延迟 —${rst}`);
  } else {
    out.push(`  ${dim}暂无样本，先用 mslxdff -chat 发一句，100次后均值更稳${rst}`);
  }
  if (s.recent.length) {
    out.push(`最近网关调用（calls.log 最近5条，含首字/tps）：`);
    for (const r of s.recent.slice(-5)) {
      const ttfb = r.ttfbMs != null ? ` 首字${r.ttfbMs}ms` : "";
      const tps = r.tps != null ? ` ${r.tps}tok/s` : (r.charsPerSec ? ` ${r.charsPerSec}ch/s` : "");
      const tok = r.usage?.completion_tokens != null ? ` tok${r.usage.completion_tokens}` : (r.chars ? ` ch${r.chars}` : "");
      out.push(`  ${fmtShanghai(r.ts)}  ${(r.model || "-").padEnd(30)}  ${String(r.status || "-").padEnd(4)}  ${r.totalMs ? r.totalMs + "ms" : (r.durationMs ? r.durationMs + "ms" : "")}${ttfb}${tps}${tok} ${r.stream ? "stream" : ""}`);
    }
  }
  out.push(`${dim}提示：以上均为 -d 网关统计，-stats 展示为平均值（EMA0.3，100次窗口 p95），单次抖动已被平滑。看实时事件用 mslxdff -log 20${rst}`);
  out.push(`${dim}──────────────────────────────────────${rst}`);
  return out.join("\n");
}
