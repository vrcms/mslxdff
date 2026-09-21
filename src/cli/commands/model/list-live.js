// 交互式 `-models` 候选合并（从 list.js 拆出以守住 ≤10KB 体积门）。
// allowAny 且空白名单的供应商（qoder/codearts 类）不写 allowlist，其模型只存在于
// daemon 聚合的 /v1/models —— 不并入这些 id，该供应商在交互列表里「一个都挑不到」。
import { loadProviderAllowedModels } from "../../../state.js";

/** 把「空白名单且已启用」供应商的网关 live 模型并入候选（按前缀归属，去重）。 */
export async function mergeLiveIds({ combinedIds, seen, knownProviders, liveIds }) {
  const needsLive = knownProviders.filter(
    (k) => String(k).toLowerCase() !== "opencode" && loadProviderAllowedModels(k).length === 0,
  );
  if (!needsLive.length) return;
  const { fetchDaemonModelIds } = await import("./live-models.js");
  const live = await fetchDaemonModelIds();
  for (const id of live) {
    if (liveIds.includes(id)) continue; // 单供应商缓存已含 → 不重复
    const pid = String(id).includes("/") ? String(id).split("/")[0].toLowerCase() : "opencode";
    if (!needsLive.some((k) => String(k).toLowerCase() === pid)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    combinedIds.push(id);
  }
}
