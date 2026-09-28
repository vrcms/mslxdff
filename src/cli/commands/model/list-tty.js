// 交互式 `-models`（TTY 多选）主流程：从 list.js 拆出以守住 ≤10KB 体积门。
// 候选合并（allowlist + live + picks 孤儿）→ 展示排序 → 勾选落盘。
// Note: 排序规则单一来源在 list-sort.js；候选集合语义不变（只改展示顺序）。
import { loadModelErrors, loadModelPicks, saveModelPicks } from "../../../state.js";
import { getPreferredModel } from "../../../auto.js";
import { pickInteractiveMulti } from "../../interactive.js";
import { filterStalePicks } from "../../../providers/model-id.js";
import { mergeLiveIds } from "./list-live.js";
import { sortModelIds } from "./list-sort.js";

/**
 * 拼交互候选：opencode live ids + 已启用 provider 的 allowlist + live 补齐 + 可见 picks。
 * 返回 { items, pickedIds }；items 已按 sortModelIds 排序。
 */
export async function buildPickerItems(liveIds, pickedIds) {
  const statuses = loadModelErrors();
  const current = getPreferredModel();
  const combinedIds = [...liveIds];
  const seen = new Set(combinedIds);
  let staleFilter = null;
  try {
    const { loadProviderConfigs, loadProviderAllowedModels } = await import("../../../state.js");
    const { buildProviderRows } = await import("../../provider-row.js");
    // 已知 = 已启用（与 -provider list 同一 enabled 口径：有 baseUrl 且有 key；
    // openrouter 有 key 即算，opencode 内置恒启用）。未启用 provider 的 picks
    // 不进列表，启用后自动回来（数据未动）。
    const knownProviders = buildProviderRows({}).filter((r) => r.enabled).map((r) => r.id);
    loadProviderConfigs();
    const allowedIds = [];
    for (const pid of knownProviders.filter((k) => String(k).toLowerCase() !== "opencode")) {
      for (const raw of loadProviderAllowedModels(pid)) {
        const canonical = `${pid}/${raw}`;
        allowedIds.push(canonical);
        if (!seen.has(canonical)) {
          seen.add(canonical);
          combinedIds.push(canonical);
        }
      }
    }
    await mergeLiveIds({ combinedIds, seen, knownProviders, liveIds });
    staleFilter = { knownProviders, liveIds, allowedIds };
  } catch {}
  // provider 已不存在的 picks 孤儿不进交互列表（数据不动，status --all 仍可审计）。
  // configs 读失败时 staleFilter 为空 → 不过滤（默认放行）。
  const visiblePicks = staleFilter ? filterStalePicks(pickedIds, staleFilter) : pickedIds;
  for (const pid of visiblePicks) {
    if (!seen.has(pid)) {
      seen.add(pid);
      combinedIds.push(pid);
    }
  }
  // 展示排序：opencode free 最前 → opencode 其他 → 各供应商分组，组内字母序。
  const items = sortModelIds(combinedIds).map((id) => {
    const e = statuses[id];
    return {
      id,
      status: typeof e === "number" ? "error" : e?.status || "normal",
      current: id === current,
      picked: pickedIds.includes(id),
    };
  });
  return { items, pickedIds };
}

/** 跑一轮 TTY 勾选并落盘 picks（取消则不写）。调用方负责 exit。 */
export async function runInteractivePick(liveIds) {
  const pickedIds = loadModelPicks();
  const { items } = await buildPickerItems(liveIds, pickedIds);
  const result = await pickInteractiveMulti(items, new Set(pickedIds), Math.max(0, items.findIndex((x) => x.current)));
  if (!result) {
    console.log("cancelled — picks unchanged");
    return;
  }
  saveModelPicks([...result]);
  console.log(`saved ${result.size} picked model(s): ${[...result].join(", ") || "(none — auto uses full list)"}`);
}
