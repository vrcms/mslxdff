import { join } from "node:path";
import { logDir } from "../../../logs.js";

/** `-model stats` 监控表（精简版 -status，只看有样本模型） */
export async function handleModelStats(args) {
  const stats = (await import("../../../state.js")).loadModelStats();
  const errors = (await import("../../../state.js")).loadModelErrors();
  const picks = (await import("../../../state.js")).loadModelPicks();
  const ids = Object.keys(stats);
  if (!ids.length) {
    console.log("暂无样本 — 先经 8989 发请求（mslxdff -chat hi 或 curl auto），100次后均值更稳");
    console.log("提示：mslxdff -status 看全量体检，mslxdff -provider <id> bench 看主动测速");
    process.exit(0);
  }
  const showAll = args.includes("--all");
  let list = ids.map((id) => ({ id, s: stats[id] }));
  if (!showAll) {
    // 默认只看正在用：free 或 picks 里的
    try {
      const cached = (await import("../../util.js")).readModelsCache(join(logDir(), "models.json"));
      const freeSet = new Set((cached?.data || []).map((m) => m.id));
      const pickSet = new Set(picks);
      const filtered = list.filter(({ id }) => freeSet.has(id) || freeSet.has(id.replace(/^opencode\//, "")) || pickSet.has(id));
      if (filtered.length) list = filtered;
    } catch {}
  }
  list.sort((a, b) => (b.s.count - a.s.count) || (b.s.lastAt - a.s.lastAt));
  const fmtMs = (v) => v == null || !Number.isFinite(v) ? "—" : v < 1000 ? `${v}ms` : `${(v / 1000).toFixed(1)}s`;
  const fmtTps = (v) => v == null || !Number.isFinite(v) ? "—" : `${v} tok/s`;
  console.log(`模型监控（${list.length} 个，样本>0 按次数）  —  mslxdff -model stats --all 看全部`);
  console.log(`  ${"模型".padEnd(30)}  ${"请求".padEnd(6)}  ${"成功".padEnd(6)}  ${"首字".padEnd(8)}  ${"总耗时".padEnd(8)}  ${"速度".padEnd(12)}  状态`);
  for (const { id, s } of list.slice(0, 20)) {
    const e = errors[id] || errors[id.replace(/^opencode\//, "")];
    const status = e ? (typeof e === "number" ? "error" : e.status || "error") : "normal";
    const ttfb = fmtMs(s.avgTtfbMs ?? s.emaTtfbMs);
    const total = fmtMs(s.avgTotalMs ?? s.emaTotalMs);
    const tps = fmtTps(s.avgTps ?? s.emaTps);
    console.log(`  ${id.padEnd(30)}  ${String(s.count).padEnd(6)}  ${String(s.count).padEnd(6)}  ${ttfb.padEnd(8)}  ${total.padEnd(8)}  ${tps.padEnd(12)}  ${status}`);
  }
  if (list.length > 20) console.log(`  … 还有 ${list.length - 20} 个`);
  console.log(`\n提示：失败次数看 mslxdff -model status；实时单条看 mslxdff -log 20`);
  process.exit(0);
}
