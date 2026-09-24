// `-stats` 模型用量报表：近 N 小时每模型 token 消耗 + 首字/总耗时/速度。
// 数据来自 src/usage/（逐请求 JSONL），不是 state.json 的终生 EMA —— 见 .scratch/stats-report/SPEC.md
import { usageReport } from "../../usage/report.js";
import { usageEnabled, usageKeepDays } from "../../usage/record.js";

const FLAGS = ["-stats", "--stats"];

export function isStatsFlag(args) {
  return FLAGS.some((f) => args.includes(f));
}

export function parseStatsArgs(args) {
  const hoursIdx = args.findIndex((a) => a === "--hours" || a === "-hours");
  const rawHours = hoursIdx >= 0 ? Number(args[hoursIdx + 1]) : NaN;
  const hours = Number.isFinite(rawHours) && rawHours > 0 ? Math.min(168, Math.floor(rawHours)) : 24;
  const modelIdx = args.findIndex((a) => a === "--model" || a === "-model");
  const rawModel = modelIdx >= 0 && args[modelIdx + 1] && !String(args[modelIdx + 1]).startsWith("-") ? args[modelIdx + 1] : null;
  return { hours, model: rawModel, json: args.includes("--json") };
}

function fmtTok(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(1)}k`;
  return `${(v / 1_000_000).toFixed(2)}M`;
}

function fmtMs(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return v < 1000 ? `${v}ms` : `${(v / 1000).toFixed(1)}s`;
}

function fmtTps(v) {
  return v == null || !Number.isFinite(v) ? "—" : `${v} tok/s`;
}

// 中文字符按 2 列宽算，否则表格错位。
function width(value) {
  let w = 0;
  for (const ch of String(value ?? "")) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return w;
}

function padCell(value, w, align = "left") {
  const text = String(value ?? "");
  const padding = " ".repeat(Math.max(0, w - width(text)));
  return align === "right" ? padding + text : text + padding;
}

function renderTable(headers, rows, aligns = []) {
  const matrix = [headers, ...rows];
  const widths = headers.map((_, col) => Math.max(...matrix.map((row) => width(row[col]))));
  const rule = (left, middle, right) => left + widths.map((w) => "─".repeat(w + 2)).join(middle) + right;
  const line = (row) => `│${row.map((cell, col) => ` ${padCell(cell, widths[col], aligns[col])} `).join("│")}│`;
  return [
    rule("┌", "┬", "┐"),
    line(headers),
    rule("├", "┼", "┤"),
    ...rows.map(line),
    rule("└", "┴", "┘"),
  ].join("\n");
}

function tokenRow(id, r) {
  return [id, r.requests, fmtTok(r.promptTokens), fmtTok(r.completionTokens), fmtTok(r.reasoningTokens), fmtTok(r.totalTokens)];
}

function performanceRow(id, r) {
  return [id, fmtMs(r.avgTtfbMs), fmtMs(r.avgTotalMs), fmtTps(r.avgTps)];
}

export function renderStats(report, { hours = 24, model = null } = {}) {
  const lines = [];
  const { models, totals } = report;
  if (!models.length) {
    lines.push(`暂无用量记录（近 ${hours}h${model ? ` · 模型 ${model}` : ""}）— 经 8989 网关发一次请求后出现`);
    lines.push("提示：mslxdff -status 看当前体检 · mslxdff -log 20 看最近事件");
    lines.push("说明：-chat 直连 mimo/big-pickle 不经网关，不计入本表");
    return lines.join("\n");
  }

  const right = "right";
  const tokenRows = [...models.map((m) => tokenRow(m.id, m)), tokenRow("合计", totals)];
  const performanceRows = [...models.map((m) => performanceRow(m.id, m)), performanceRow("合计", totals)];
  lines.push(`模型用量报告（近 ${hours}h${model ? ` · 筛选 ${model}` : ""}）`);
  lines.push(`成功请求：${totals.requests} 次 · 模型：${models.length} 个`);
  lines.push("");
  lines.push("Token 用量");
  lines.push(renderTable(["模型", "请求", "输入", "输出", "思考", "合计"], tokenRows, ["left", right, right, right, right, right]));
  lines.push("");
  lines.push("响应性能");
  lines.push(renderTable(["模型", "首字", "总耗时", "速度"], performanceRows, ["left", right, right, right]));
  lines.push("");
  lines.push("说明：速度 = 输出 tokens ÷ 生成耗时（总耗时−首字），按窗口加权；只统计成功请求。");
  lines.push("范围：只含经 8989 网关的成功请求；不含失败请求和 -chat 直连。");
  const keepDays = usageKeepDays();
  if (hours > keepDays * 24) {
    lines.push(`警告：查询 ${hours}h 超过数据保留 ${keepDays} 天，历史可能不完整。`);
  } else {
    lines.push(`数据保留 ${keepDays} 天；更早的历史已删除。`);
  }
  lines.push("明细口径：本表按模型聚合，不展开 via、interrupted 和单次 tps。");
  lines.push("数值使用 k/M 缩写；需要精确值或机器处理请加 --json。");
  lines.push("可调：mslxdff -stats --hours 1 | --model <id> | --json");
  return lines.join("\n");
}

export async function handleStats(args) {
  if (!isStatsFlag(args)) return false;
  const { hours, model, json } = parseStatsArgs(args);
  if (!usageEnabled()) {
    console.log("用量记录已关闭（MSLXDFF_USAGE_LOG=0）—— 去掉该 env 后重启 daemon 即可恢复采集。");
    return true;
  }
  const report = await usageReport({ hours, model, now: Date.now() });
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return true;
  }
  console.log(renderStats(report, { hours, model }));
  return true;
}
