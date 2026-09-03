import { join } from "node:path";
import { createModelsService } from "../../../models.js";
import { createUpstreamClient } from "../../../upstream.js";
import { logDir } from "../../../logs.js";
import { loadModelErrors, loadModelPicks, saveModelPicks } from "../../../state.js";
import { getPreferredModel } from "../../../auto.js";
import { fmtShanghaiYMDHM } from "../../../time.js";
import { readModelsCache } from "../../util.js";
import { pickInteractiveMulti } from "../../interactive.js";
import { buildAliasMap, readFullAliases, renderProviderList, renderFreeList, groupByProvider } from "./list-render.js";
import { renderOtherProviders } from "./list-providers.js";

/**
 * `-model list` 全流程：参数解析 → 刷新/回退 → provider 分支 → TTY 交互 → 分组渲染。
 * 渲染下沉 list-render / list-providers，本文件只留流程编排。
 */
export async function handleModelList(args, idx, sub) {
  let modelListProvider = null;
  let modelListJson = false;
  if (sub === "list") {
    const restArgs = args.slice(idx + 2);
    for (let i = 0; i < restArgs.length; i++) {
      const a = String(restArgs[i] || "");
      if (a === "--json" || a === "-json") modelListJson = true;
      else if (a === "--provider" || a === "-provider" || a === "--providerId") { modelListProvider = String(restArgs[i + 1] || "").trim() || null; i++; }
      else if (!a.startsWith("-") && !modelListProvider) modelListProvider = a;
    }
    if (modelListProvider) {
      const { normalizeProviderId } = await import("../../../providers/model-id.js");
      const nid = normalizeProviderId(modelListProvider);
      modelListProvider = nid || modelListProvider.toLowerCase();
    }
  }
  const cacheFile = join(logDir(), "models.json");
  async function tryRefreshModels() {
    try {
      const models = createModelsService({
        baseUrl: process.env.UPSTREAM_BASE_URL || "https://opencode.ai",
        headers: createUpstreamClient({}).headers,
        refreshMs: 0,
        cacheFile,
      });
      const list = await Promise.race([
        models.get(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("refresh timeout")), 4000)),
      ]);
      return list;
    } catch {
      return null;
    }
  }
  try {
    let ids = [];
    let cachedAt = null;
    let refreshed = null;
    refreshed = await tryRefreshModels();
    if (refreshed?.data) {
      ids = (refreshed.data || []).map((m) => m.id).filter(Boolean);
      cachedAt = refreshed.cachedAt || Date.now();
    } else {
      const cached = readModelsCache(cacheFile);
      if (cached) {
        ids = (cached.data || []).map((m) => m.id).filter(Boolean);
        cachedAt = cached.cachedAt || null;
      } else {
        throw new Error("no cached models and refresh failed");
      }
    }
    if (modelListProvider) {
      const prov = String(modelListProvider).toLowerCase();
      const filtered = ids.filter((id) => {
        const slash = String(id).indexOf("/");
        const p = slash > 0 ? String(id).slice(0, slash).toLowerCase() : "opencode";
        return p === prov;
      });
      if (prov !== "opencode" && filtered.length === 0) {
        try {
          const { loadProviderAllowedModels, loadProviderAllowAnyModels, loadProviderBaseUrl } = await import("../../../state.js");
          const { loadModelAliases, getAliasForModel } = await import("../../../providers/model-id.js");
          try { loadModelAliases(); } catch {}
          const allowed = loadProviderAllowedModels(prov);
          const allowAny = loadProviderAllowAnyModels(prov);
          const baseUrl = loadProviderBaseUrl(prov);
          if (modelListJson) {
            const data = allowed.length
              ? allowed.map((raw) => ({ id: `${prov}/${raw}`, object: "model" }))
              : [];
            console.log(JSON.stringify({ object: "list", data }, null, 2));
            process.exit(0);
          }
          if (!allowed.length) {
            if (allowAny) {
              console.log(`provider "${prov}" allowAny ON (allowlist 空=放行全部)${baseUrl ? `  baseUrl=${baseUrl}` : ""}`);
              console.log(`  (未设 allowlist，全部模型放行)  查看 live 列表: mslxdff -provider ${prov} models`);
            } else {
              console.log(`no models for provider "${prov}" — allowlist 空 + allowAny OFF = 阻塞`);
              console.log(`  设白名单: mslxdff -provider ${prov} allowlist set <model1> <model2>  或  mslxdff -provider ${prov} allowAny on`);
              console.log(`  live 查看: mslxdff -provider ${prov} models`);
            }
            process.exit(0);
          }
          const at2 = cachedAt ? ` (cached ${fmtShanghaiYMDHM(cachedAt)})` : "";
          console.log(`${allowed.length} model(s) for ${prov}${at2} (allowlist，原名 + 别名):`);
          const pickedIds2 = loadModelPicks();
          for (const raw of allowed) {
            const canonical = `${prov}/${raw}`;
            let alias = null;
            try { alias = getAliasForModel(canonical); } catch {}
            if (!alias && String(canonical).includes("/")) alias = String(canonical).replace(/\//g, "-");
            const aliasStr = alias && alias !== canonical ? `  (别名: ${alias})` : "";
            const mark2 = pickedIds2.includes(canonical) || (alias && pickedIds2.includes(alias)) ? "*" : " ";
            console.log(`  ${mark2} ${canonical}${aliasStr}`);
          }
          process.exit(0);
        } catch {}
      }
      ids = filtered;
      if (modelListJson) {
        console.log(JSON.stringify({ object: "list", data: ids.map((id) => ({ id, object: "model" })) }, null, 2));
        process.exit(0);
      }
      if (!ids.length) {
        console.log(`no models for provider "${prov}" — try: mslxdff -provider ${prov} models  or  mslxdff -model refresh`);
        process.exit(0);
      }
    } else if (modelListJson) {
      console.log(JSON.stringify({ object: "list", data: ids.map((id) => ({ id, object: "model" })) }, null, 2));
      process.exit(0);
    }
    if (!ids.length) {
      console.log("no models available — try: mslxdff -model refresh");
      process.exit(0);
    }
    if (sub === undefined && process.stdin.isTTY && process.stdout.isTTY) {
      const statuses = loadModelErrors();
      const current = getPreferredModel();
      const pickedIds = loadModelPicks();
      const combinedIds = [...ids];
      const seen = new Set(combinedIds);
      try {
        const { loadProviderConfigs, loadProviderAllowedModels } = await import("../../../state.js");
        const configs = loadProviderConfigs();
        for (const pid of Object.keys(configs).filter((k) => String(k).toLowerCase() !== "opencode")) {
          const allowed = loadProviderAllowedModels(pid);
          for (const raw of allowed) {
            const canonical = `${pid}/${raw}`;
            if (!seen.has(canonical)) {
              seen.add(canonical);
              combinedIds.push(canonical);
            }
          }
        }
      } catch {}
      for (const pid of pickedIds) {
        if (!seen.has(pid)) {
          seen.add(pid);
          combinedIds.push(pid);
        }
      }
      const items = combinedIds.map((id) => {
        const e = statuses[id];
        return {
          id,
          status: typeof e === "number" ? "error" : e?.status || "normal",
          current: id === current,
          picked: pickedIds.includes(id),
        };
      });
      const result = await pickInteractiveMulti(items, new Set(pickedIds), Math.max(0, items.findIndex((x) => x.current)));
      if (!result) {
        console.log("cancelled — picks unchanged");
        process.exit(0);
      }
      saveModelPicks([...result]);
      console.log(`saved ${result.size} picked model(s): ${[...result].join(", ") || "(none — auto uses full list)"}`);
      process.exit(0);
    }
    const at = cachedAt ? ` (cached ${fmtShanghaiYMDHM(cachedAt)})` : "";
    const pickedIds = loadModelPicks();
    const { groups, sortedProvs } = groupByProvider(ids);
    const { loadModelAliases, getAliasForModel } = await import("../../../providers/model-id.js");
    if (modelListProvider) {
      let aliasMap = {};
      try {
        loadModelAliases();
        aliasMap = buildAliasMap(ids, getAliasForModel);
      } catch {}
      renderProviderList({ ids, at, pickedIds, modelListProvider, sortedProvs, groups, aliasMap });
    } else {
      let aliasMap = {};
      let fullAliases = {};
      try {
        loadModelAliases();
        aliasMap = buildAliasMap(ids, getAliasForModel);
        fullAliases = readFullAliases();
      } catch {}
      renderFreeList({ ids, at, pickedIds, sortedProvs, groups, aliasMap });
      try {
        await renderOtherProviders({ pickedIds, ids, fullAliases });
      } catch {}
      console.log(`\npicked only constrains auto; manage with: mslxdff -models (TTY) | mslxdff -model pick <id> | mslxdff -model unpick <id> | mslxdff -model pick clear`);
    }
  } catch (err) {
    console.error(`could not fetch models: ${String(err?.message || err)}`);
    process.exit(1);
  }
  process.exit(0);
}
