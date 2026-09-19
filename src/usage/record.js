// 逐请求 usage 落盘：按日切片的 JSONL，供 -stats 做时间窗口聚合。
// Note: 与 logs.js 的 calls/errors/events 不同，这里按日分片 + 保留期删旧文件，
// 不走 1MB 环形截断 —— 环形会把 24h 窗口的数据裁到末 100 行。见 .scratch/stats-report/SPEC.md
import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { logDir } from "../logs.js";

const DEFAULT_KEEP_DAYS = 2;
const DAY_MS = 86_400_000;

export function usageEnabled() {
  return process.env.MSLXDFF_USAGE_LOG !== "0";
}

export function usageKeepDays() {
  const n = Number(process.env.MSLXDFF_USAGE_KEEP_DAYS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_KEEP_DAYS;
}

export function usageDir({ dir } = {}) {
  return join(dir || logDir(), "usage");
}

export function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function usageFileFor(date, { dir } = {}) {
  return join(usageDir({ dir }), `${ymd(date)}.jsonl`);
}

// 删掉早于保留期的日文件。文件名是 YYYY-MM-DD，可直接字典序比较。
export async function pruneUsage({ dir, keepDays, now = new Date() } = {}) {
  const keep = Number.isInteger(keepDays) && keepDays > 0 ? keepDays : usageKeepDays();
  const cutoff = ymd(new Date(now.getTime() - keep * DAY_MS));
  const removed = [];
  let files = [];
  try {
    files = await readdir(usageDir({ dir }));
  } catch {
    return removed; // 目录还不存在 = 无事可做
  }
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    const day = f.slice(0, -".jsonl".length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day >= cutoff) continue;
    try {
      await unlink(join(usageDir({ dir }), f));
      removed.push(f);
    } catch {}
  }
  return removed;
}

let lastPrunedDay = null;

// 追加一行 usage。异步写，调用方可 fire-and-forget（不阻塞流式响应）。
// 清理是惰性的且每天最多触发一次，避免每个请求都去 readdir。
export async function recordUsage(entry, { dir, now = new Date() } = {}) {
  if (!usageEnabled() || !entry || typeof entry !== "object") return null;
  const row = { ts: now.getTime(), ...entry };
  try {
    await mkdir(usageDir({ dir }), { recursive: true });
    await appendFile(usageFileFor(now, { dir }), JSON.stringify(row) + "\n");
  } catch {
    return null;
  }
  const today = ymd(now);
  if (lastPrunedDay !== today) {
    lastPrunedDay = today;
    pruneUsage({ dir, now }).catch(() => {});
  }
  return row;
}

// 从 relay 结果组装一行 usage —— 行形状由本模块拥有，调用方只交原始字段。
// usage 即 metrics.js 的 extractUsageFromJson 输出（prompt/completion/total/reasoning）。
export function recordChatUsage({ model, via, usage, ttfbMs, totalMs, tps, interrupted } = {}) {
  return recordUsage({
    model,
    via,
    interrupted,
    prompt_tokens: usage?.prompt_tokens ?? 0,
    completion_tokens: usage?.completion_tokens ?? 0,
    total_tokens: usage?.total_tokens ?? 0,
    reasoning_tokens: usage?.reasoning_tokens ?? 0,
    ttfbMs: Number.isFinite(ttfbMs) ? ttfbMs : null,
    totalMs: Number.isFinite(totalMs) ? totalMs : null,
    tps: Number.isFinite(tps) ? tps : null,
  });
}

// 测试用：重置惰性清理标记，避免跨用例串味（置于文件末，业务函数在其上）
export function _resetPruneMarker() {
  lastPrunedDay = null;
}
