// 窗口用量聚合：JSONL 行数组 + 时间窗口 → 每模型 token/速度报表。
// 纯函数（aggregateUsage）与薄 IO（readUsageRows / usageReport）分开，前者可离线单测。
// Note: 速度用加权口径 Σcompletion / ΣcompletionMs，不用算术平均 —— 短回答会把算术均值拉飞。
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { usageDir } from "./record.js";

const HOUR_MS = 3_600_000;

function tok(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function ms(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function blank(id) {
  return {
    id,
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    ttfbSumMs: 0,
    ttfbN: 0,
    totalSumMs: 0,
    totalN: 0,
    completionMsSum: 0,
    tpsTokSum: 0,
  };
}

// 把累计量收敛成对外字段：平均首字/平均总耗时/加权速度。
function finalize(a) {
  return {
    id: a.id,
    requests: a.requests,
    promptTokens: a.promptTokens,
    completionTokens: a.completionTokens,
    totalTokens: a.totalTokens,
    reasoningTokens: a.reasoningTokens,
    avgTtfbMs: a.ttfbN ? Math.round(a.ttfbSumMs / a.ttfbN) : null,
    avgTotalMs: a.totalN ? Math.round(a.totalSumMs / a.totalN) : null,
    avgTps: a.completionMsSum > 0 ? Number((a.tpsTokSum / (a.completionMsSum / 1000)).toFixed(1)) : null,
  };
}

function fold(acc, r) {
  acc.requests++;
  const prompt = tok(r.prompt_tokens);
  const comp = tok(r.completion_tokens);
  acc.promptTokens += prompt;
  acc.completionTokens += comp;
  const total = tok(r.total_tokens);
  acc.totalTokens += total || prompt + comp;
  acc.reasoningTokens += tok(r.reasoning_tokens);

  const ttfb = ms(r.ttfbMs ?? r.ttfb_ms);
  if (ttfb != null) {
    acc.ttfbSumMs += ttfb;
    acc.ttfbN++;
  }
  const totalMs = ms(r.totalMs ?? r.total_ms);
  if (totalMs != null && totalMs > 0) {
    acc.totalSumMs += totalMs;
    acc.totalN++;
  }
  // 生成阶段耗时 = 总耗时 - 首字（首字缺失按 0 计）
  if (totalMs != null && totalMs > 0 && comp > 0) {
    const compMs = Math.max(0, totalMs - (ttfb ?? 0));
    if (compMs > 0) {
      acc.completionMsSum += compMs;
      acc.tpsTokSum += comp;
    }
  }
  return acc;
}

// 纯函数：只做过滤 + 归并，不碰磁盘。
export function aggregateUsage(rows, { hours = 24, now = Date.now(), model = null } = {}) {
  const windowHours = Number.isFinite(Number(hours)) && Number(hours) > 0 ? Number(hours) : 24;
  const untilN = Number(now);
  const until = Number.isFinite(untilN) ? untilN : Date.now();
  const since = until - windowHours * HOUR_MS;
  const byModel = new Map();
  const sum = blank(null);
  let scanned = 0;

  if (Array.isArray(rows)) {
    for (const r of rows) {
      if (!r || typeof r !== "object") continue;
      const ts = Number(r.ts);
      if (!Number.isFinite(ts) || ts < since || ts > until) continue;
      const id = String(r.model || "").trim();
      if (!id) continue;
      // model 过滤同时接受 canonical 全称与裸 id（如 --model big-pickle 匹配 opencode/big-pickle 行）
      if (model && id !== model && !id.endsWith("/" + model)) continue;
      scanned++;
      let acc = byModel.get(id);
      if (!acc) { acc = blank(id); byModel.set(id, acc); }
      fold(acc, r);
      fold(sum, r);
    }
  }
  const models = [...byModel.values()].map(finalize);
  models.sort((a, b) => (b.totalTokens - a.totalTokens) || (b.requests - a.requests) || a.id.localeCompare(b.id));
  return {
    windowHours,
    since,
    until,
    rows: scanned,
    models,
    totals: finalize(sum),
  };
}

// 读保留期内的日文件并只留窗口内的行（保留期默认 2 天，文件数很少，全读即可）。
export async function readUsageRows({ dir, hours = 24, now = Date.now() } = {}) {
  const since = Number(now) - (Number(hours) > 0 ? Number(hours) : 24) * HOUR_MS;
  let files = [];
  try {
    files = (await readdir(usageDir({ dir }))).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const rows = [];
  for (const f of files) {
    let text = "";
    try {
      text = await readFile(join(usageDir({ dir }), f), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (Number(r?.ts) >= since) rows.push(r);
      } catch {}
    }
  }
  return rows;
}

export async function usageReport({ dir, hours = 24, now = Date.now(), model = null } = {}) {
  const rows = await readUsageRows({ dir, hours, now });
  return aggregateUsage(rows, { hours, now, model });
}
