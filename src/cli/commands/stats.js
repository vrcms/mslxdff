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

// 中文字符按 2 列宽算，否则表格错位
function width(s) {
  let w = 0;
  for (const ch of String(s)) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return w;
}

function padW(s, w) {
  const t = String(s);
  return t + " ".repeat(Math.max(0, w - width(t)));
}

function rowText(id, r) {
  return `  ${padW(id, 30)}  ${padW(r.requests, 6)}  ${padW(fmtTok(r.promptTokens), 8)}  ${padW(fmtTok(r.completionTokens), 10)}  ${padW(fmtTok(r.totalTokens), 8)}  ${padW(fmtMs(r.avgTtfbMs), 7)}  ${padW(fmtMs(r.avgTotalMs), 8)}  ${fmtTps(r.avgTps)}`;
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
  lines.push(`模型用量（近 ${hours}h · 成功请求 ${totals.requests} 次 · ${models.length} 个模型）`);
  lines.push(`  ${padW("模型", 30)}  ${padW("请求", 6)}  ${padW("prompt", 8)}  ${padW("输出", 10)}  ${padW("合计", 8)}  ${padW("首字", 7)}  ${padW("总耗时", 8)}  速度`);
  for (const m of models) lines.push(rowText(m.id, m));
  lines.push(`  ${"-".repeat(76)}`);
  lines.push(rowText("合计", totals));
  if (totals.reasoningTokens > 0) lines.push(`  其中思考 tokens：${fmtTok(totals.reasoningTokens)}`);
  lines.push("");
  lines.push("说明：速度 = 输出 tokens ÷ 生成耗时（总耗时−首字），按窗口加权；只统计成功请求。");
  lines.push(`      -chat 直连 mimo/big-pickle 不经 8989 网关，不计入。数据保留 ${usageKeepDays()} 天，mslxdff -stats --hours 1|--json|--model <id> 可调。`);
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