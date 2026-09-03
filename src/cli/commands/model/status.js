import { join } from "node:path";
import { logDir } from "../../../logs.js";
import { loadModelErrors, loadModelPicks } from "../../../state.js";
import { fmtShanghaiYMDHM } from "../../../time.js";
import { readModelsCache } from "../../util.js";

/** `-model status` 健康表 + 孤儿隐藏（--all 看全部） */
export async function handleModelStatus(args) {
  const statuses = loadModelErrors();
  const cacheFile = join(logDir(), "models.json");
  const cached = readModelsCache(cacheFile);
  const showAll = args.includes("--all") || args.includes("-all") || args.includes("--orphans");
  const freeIds = new Set((cached?.data || []).map((m) => m.id));
  const picks = new Set(loadModelPicks());
  const ids = new Set([...freeIds]);
  if (showAll) {
    for (const k of Object.keys(statuses)) ids.add(k);
    for (const k of picks) ids.add(k);
  } else {
    // 默认只看正在用的：free 列表内，且（被 picks 钉住 或 近期有错误/在用）
    // 不在 free 里的孤儿直接隐藏，需 --all 才看
    for (const k of Object.keys(statuses)) if (freeIds.has(k)) ids.add(k);
    for (const k of picks) if (freeIds.has(k)) ids.add(k);
    if (!ids.size && freeIds.size === 0) {
      // 无缓存时回退显示有状态的，避免空屏
      for (const k of Object.keys(statuses)) ids.add(k);
    }
  }
  if (!ids.size) {
    console.log(showAll ? "no models (free + orphans) — try: mslxdff -model refresh" : "no free models — try: mslxdff -model refresh (use --all to see orphans)");
    process.exit(0);
  }
  for (const id of ids) {
    const e = statuses[id];
    const st = typeof e === "number" ? "error" : e?.status || "normal";
    const at = typeof e === "number" ? e : e?.at;
    const when = at ? `  (${fmtShanghaiYMDHM ? fmtShanghaiYMDHM(at) : at})` : "";
    const extra = e?.code ? `  HTTP ${e.code}` : "";
    const orphanMark = !freeIds.has(id) ? "  [orphan]" : "";
    console.log(`  ${id}  ${st}${when}${extra}${orphanMark}`);
  }
  if (!showAll) {
    const orphans = [...new Set([...Object.keys(statuses), ...picks])].filter((x) => !freeIds.has(x));
    if (orphans.length) console.log(`\n(已隐藏 ${orphans.length} 个不在用/已下线模型，需查看: mslxdff -model status --all)`);
  }
  process.exit(0);
}
