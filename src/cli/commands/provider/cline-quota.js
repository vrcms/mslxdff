/**
 * mslxdff -provider cline quota [--json] [--account <hash>] [--model <substr>]
 * 只读：聚合 cline-usage.jsonl 的账号×模型双口径统计，不碰转发/daemon/凭据。
 * free 口径：本周期 tokens + 已完成周期数/上周期产出；pass 口径：近 24h + 累计。
 * 空账本给空状态引导；--json 供脚本消费。
 */
import { normalizeProviderId } from "../../../providers/model-id.js";
import { loadAndAggregate } from "../../../providers/cline/usage.js";

function pickOpt(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return "";
  const v = args[i + 1];
  return v && !String(v).startsWith("-") ? String(v) : "";
}

/** 纯渲染：entries 为 aggregateUsage 的 value 数组（可单测，不碰 IO）。 */
export function formatQuota(entries) {
  const list = [...(entries || [])];
  if (!list.length) {
    return [
      "cline quota：账本为空（cline-usage.jsonl 无记录）。",
      "先用 cline 模型成功跑一轮对话（流式/非流式都会记账），再来看：",
      "  mslxdff -provider cline quota",
    ].join("\n");
  }
  const byAcct = new Map();
  for (const e of list) {
    if (!byAcct.has(e.accountId)) byAcct.set(e.accountId, []);
    byAcct.get(e.accountId).push(e);
  }
  const lines = [`cline quota：${byAcct.size} 个账号 · ${list.length} 条账号×模型`];
  for (const [acct, rows] of byAcct) {
    lines.push(`\n[${acct}]`);
    for (const r of rows.sort((a, b) => String(a.model).localeCompare(String(b.model)))) {
      if (r.modelType === "free") {
        lines.push(`  ${r.model}（free）：本周期 ${r.currentCycleTokens} · 已完成 ${r.completedCycles} 周期（上周期 ${r.lastCompletedCycleTokens}）· 累计 ${r.totalTokens}`);
      } else {
        lines.push(`  ${r.model}（pass）：近24h ${r.last24hTokens} · 累计 ${r.totalTokens}`);
      }
    }
  }
  return lines.join("\n");
}

export async function handleClineQuota(id, sub, rest = [], args = []) {
  if (normalizeProviderId(id) !== "cline") return false;
  if (String(sub || "").toLowerCase() !== "quota") return false;
  const wantsJson = args.includes("--json") || args.includes("-json");
  const acctFilter = pickOpt(args, "--account");
  const modelFilter = pickOpt(args, "--model");
  const map = await loadAndAggregate();
  let entries = [...map.values()];
  if (acctFilter) entries = entries.filter((e) => e.accountId === acctFilter);
  if (modelFilter) entries = entries.filter((e) => String(e.model || "").includes(modelFilter));
  if (wantsJson) {
    console.log(JSON.stringify({ provider: "cline", entries }, null, 2));
    process.exit(0);
  }
  console.log(formatQuota(entries));
  if (!entries.length && map.size > 0) {
    console.log("\n（过滤条件无命中，去掉 --account/--model 再试）");
  }
  process.exit(0);
}
