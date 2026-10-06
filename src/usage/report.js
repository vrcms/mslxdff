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
// 思考 tokens 的四态判定（行级）：上报优先 → 有思考字符就估算 → 明确报 0 才算 0 → 否则未知。
// 「上游报 0 却确有思考内容」按观测走估算：qoder 就是这形状，报 0 是上游没填，不是模型没想。
export function resolveReasoning(row) {
  const reportedVal = Number(row?.reasoning_tokens);
  // 兼容判据：修复前的旧行没有 reasoning_reported，但带着真实上报值 —— 不能因缺字段退化成未知
  const hasReported = row?.reasoning_reported === 1 || (Number.isFinite(reportedVal) && reportedVal > 0);
  const chars = Number(row?.reasoning_chars);
  const charCount = Number.isFinite(chars) && chars > 0 ? Math.trunc(chars) : 0;
  if (hasReported && Number.isFinite(reportedVal) && reportedVal > 0) return { value: reportedVal, source: "reported" };
  if (charCount > 0) {
    const cap = Number(row?.completion_tokens);
    const est = Math.ceil(charCount / 4); // 与 src/providers/cline/usage.js 的既有估算口径一致
    return { value: Number.isFinite(cap) && cap > 0 ? Math.min(est, cap) : est, source: "estimated" };
  }
  if (hasReported) return { value: 0, source: "reported" }; // 该轮真的没思考
  return { value: 0, source: "none" }; // 无从判断 → 表格渲染 —，绝不渲染成 0
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
    reasoningReported: 0,
    reasoningEstimated: 0,
    reasoningReportedRows: 0,
    reasoningEstimatedRows: 0,
    reasoningChars: 0,
    streamRequests: 0,
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
    reasoningTokens: a.reasoningReported + a.reasoningEstimated,
    avgTtfbMs: a.ttfbN ? Math.round(a.ttfbSumMs / a.ttfbN) : null,
    avgTotalMs: a.totalN ? Math.round(a.totalSumMs / a.totalN) : null,
    // 思考来源：上报与估算同时存在时是 mixed——合计值不冒充单一精确数（spec 锁死）
    reasoningSource: a.reasoningReportedRows > 0 && a.reasoningEstimatedRows > 0 ? "mixed"
      : a.reasoningReportedRows > 0 ? "reported"
      : a.reasoningEstimatedRows > 0 ? "estimated" : "none",
    reasoningChars: a.reasoningChars,
    ttfSamples: a.ttfbN,
    streamRequests: a.streamRequests,
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
  // 思考：四态分层累计（上报/估算各算各的，未知不贡献数值），原始字符数照实累加
  const rs = resolveReasoning(r);
  if (rs.source === "reported") { acc.reasoningReported += rs.value; acc.reasoningReportedRows++; }
  else if (rs.source === "estimated") { acc.reasoningEstimated += rs.value; acc.reasoningEstimatedRows++; }
  acc.reasoningChars += tok(r.reasoning_chars);
  // 首字样本分母：非流式行既无首字也不该摊进分母；缺 stream 的旧行按未知保守计入
  if (r.stream !== 0) acc.streamRequests++;

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
export function aggregateUsage(rows, { hours = 24, since: sinceOpt = null, now = Date.now(), model = null } = {}) {
  const untilN = Number(now);
  const until = Number.isFinite(untilN) ? untilN : Date.now();
  // since（绝对窗口起点，毫秒）优先于 hours：CLI 默认窗口「今日 0 点 → 现在」靠它精确落在 0 点，不随查询时刻漂移
  const sinceMs = sinceOpt == null ? NaN : Number(sinceOpt);
  const hasSince = Number.isFinite(sinceMs);
  const hoursN = Number(hours);
  const windowHours = hasSince ? (until - sinceMs) / HOUR_MS : Number.isFinite(hoursN) && hoursN > 0 ? hoursN : 24;
  const since = hasSince ? sinceMs : until - windowHours * HOUR_MS;
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
export async function readUsageRows({ dir, hours = 24, since: sinceOpt = null, now = Date.now() } = {}) {
  const sinceMs = sinceOpt == null ? NaN : Number(sinceOpt);
  const hoursN = Number(hours);
  const since = Number.isFinite(sinceMs) ? sinceMs : Number(now) - (Number.isFinite(hoursN) && hoursN > 0 ? hoursN : 24) * HOUR_MS;
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

export async function usageReport({ dir, hours = 24, since = null, now = Date.now(), model = null } = {}) {
  const rows = await readUsageRows({ dir, hours, since, now });
  return aggregateUsage(rows, { hours, since, now, model });
}
