/**
 * mslxdff -provider cline free [sync] [--yes] [--json] [--keep-extra]
 * 只读：直查上游免费目录（公开接口，无凭据）并与当前 allowlist 求差；只有 `free sync --yes` 才写 allowlist。
 * allowlist 存裸 id（不带 cline/ 前缀），与 normalizeAllowedModel 语义一致；落盘走 saveProviderAllowedModels 保留 keys/baseUrl。
 */
import { normalizeProviderId } from "../../../providers/model-id.js";
import { fetchFreeCatalog, FALLBACK_FREE, FREE_CATALOG_PATH } from "../../../providers/cline/free-catalog.js";

/** 上游不可达时退回内置兜底目录（标注 source=fallback，供人判断是否该落盘） */
async function loadCatalog() {
  const cat = await fetchFreeCatalog({});
  if (cat.ok) return { ...cat, source: "upstream" };
  return {
    ...cat,
    source: "fallback",
    models: FALLBACK_FREE.map((m) => ({ ...m })),
    ids: FALLBACK_FREE.map((m) => m.id),
  };
}

function computeNext(current, freeIds, keepExtra) {
  const next = keepExtra ? [...new Set([...current, ...freeIds])] : [...freeIds];
  return {
    next,
    added: next.filter((m) => !current.includes(m)),
    removed: current.filter((m) => !next.includes(m)),
    kept: next.filter((m) => current.includes(m)),
  };
}

function renderList(cat, current, next, plan) {
  console.log(`cline free 目录（GET ${FREE_CATALOG_PATH} → free）：${cat.ids.length} 个${cat.source === "fallback" ? "（内置兜底，上游不可达）" : ""}`);
  const w = Math.max(20, ...cat.ids.map((s) => s.length)) + 2;
  for (const m of cat.models) console.log(`   + ${String(m.id).padEnd(w)}${m.name && m.name !== m.id ? m.name : ""}`);
  console.log(`当前 allowlist：${current.length} 个`);
  for (const id of current) console.log(`   ${next.includes(id) ? "✓" : "-"} ${id}${next.includes(id) ? "" : "          （不在 free 目录）"}`);
  console.log(`结果：allowlist ${current.length} → ${next.length}（+${plan.added.length} 新增 / -${plan.removed.length} 移除 / ${plan.kept.length} 保留）`);
}

export async function handleClineFree(id, sub, rest = [], args = []) {
  if (normalizeProviderId(id) !== "cline") return false;
  if (String(sub || "").toLowerCase() !== "free") return false;
  const isSync = String(rest[1] || "").toLowerCase() === "sync";
  const wantsJson = args.includes("--json") || args.includes("-json");
  const yes = args.includes("--yes") || args.includes("-y");
  const keepExtra = args.includes("--keep-extra");

  const { loadProviderAllowedModels, saveProviderAllowedModels } = await import("../../../state.js");
  const cat = await loadCatalog();
  const current = loadProviderAllowedModels("cline");
  const plan = computeNext(current, cat.ids, keepExtra);
  const dryRun = !(isSync && yes);
  let written = [];
  if (isSync && !dryRun) {
    try {
      written = saveProviderAllowedModels("cline", plan.next);
    } catch (e) {
      console.error(`❌ 写入 allowlist 失败: ${String(e?.message || e)}`);
      process.exit(1);
    }
  }
  const warning = cat.source === "fallback" ? `上游目录不可达（${cat.error || cat.status}），使用内置兜底目录，可能过期` : null;

  if (wantsJson) {
    console.log(JSON.stringify({
      provider: "cline",
      mode: isSync ? "sync" : "list",
      source: cat.source,
      url: cat.url,
      free: cat.ids,
      current,
      next: plan.next,
      added: plan.added,
      removed: plan.removed,
      kept: plan.kept,
      dryRun,
      written,
      ...(warning ? { warning } : {}),
    }, null, 2));
    process.exit(0);
  }

  if (warning) console.error(`⚠️  ${warning}`);
  renderList(cat, current, plan.next, plan);
  if (!isSync) {
    console.log(`\n预览（只读）。一键同步：mslxdff -provider cline free sync --yes   ·   只增不删：加 --keep-extra`);
  } else if (dryRun) {
    console.log(`\n预览模式，未写入。执行：mslxdff -provider cline free sync --yes${keepExtra ? " --keep-extra" : ""}`);
  } else {
    console.log(`\n✅ 已写入 allowlist：${written.length} 个（providerConfigs.cline.allowedModels）`);
    console.log(`   生效：mslxdff -restart（daemon 的 /v1/models 聚合有 10 分钟缓存，重启即刷新）`);
  }
  process.exit(0);
}
