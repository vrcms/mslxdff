import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createModelsService } from "../../models.js";
import { createUpstreamClient } from "../../upstream.js";
import { logDir } from "../../logs.js";
import { loadModelErrors, savePreferredModel, loadPreferredModel, loadModelPicks, saveModelPicks } from "../../state.js";
import { getPreferredModel } from "../../auto.js";
import { fmtShanghaiYMDHM } from "../../time.js";
import { readModelsCache } from "../util.js";
import { pickInteractiveMulti } from "../interactive.js";

export async function handleModel(args) {
  if (!(args.includes("-model") || args.includes("-models"))) return false;
  const idx = args.findIndex((x) => x === "-model" || x === "-models");
  const sub = args[idx + 1];
  if (sub === "refresh") {
    const models = createModelsService({
      baseUrl: process.env.UPSTREAM_BASE_URL || "https://opencode.ai",
      headers: createUpstreamClient({}).headers,
      refreshMs: 0,
      cacheFile: join(logDir(), "models.json"),
    });
    try {
      const list = await models.get();
      const ids = (list.data || []).map((m) => m.id).filter(Boolean);
      console.log(`refreshed: ${ids.length} free model(s)`);
      for (const id of ids) console.log(`  ${id}`);
    } catch (err) {
      console.error(`could not refresh models: ${String(err?.message || err)}`);
      process.exit(1);
    }
    process.exit(0);
  }
  if (sub === "status") {
    const statuses = loadModelErrors();
    const cacheFile = join(logDir(), "models.json");
    const cached = readModelsCache(cacheFile);
    const ids = new Set([
      ...(cached?.data || []).map((m) => m.id),
      ...Object.keys(statuses),
    ]);
    for (const id of ids) {
      const e = statuses[id];
      const st = typeof e === "number" ? "error" : e?.status || "normal";
      const at = typeof e === "number" ? e : e?.at;
      const when = at ? `  (${fmtShanghaiYMDHM ? fmtShanghaiYMDHM(at) : at})` : "";
      const extra = e?.code ? `  HTTP ${e.code}` : "";
      console.log(`  ${id}  ${st}${when}${extra}`);
    }
    process.exit(0);
  }
  if (sub === "set" && args[idx + 2]) {
    const id = args[idx + 2];
    savePreferredModel(id);
    const picks = [...new Set([...loadModelPicks(), id])];
    saveModelPicks(picks);
    console.log(`default model set to: ${id} (daemon hot-reloads on next request)`);
    console.log(`picked: ${picks.join(", ") || "(none)"} (auto will pick within these)`);
    process.exit(0);
  }
  if (sub === "pick" && args[idx + 2] && args[idx + 2] !== "clear") {
    const picks = [...new Set([...loadModelPicks(), args[idx + 2]])];
    saveModelPicks(picks);
    console.log(`picked: ${picks.join(", ") || "(none)"} (auto will pick within these)`);
    process.exit(0);
  }
  if (sub === "pick" && args[idx + 2] === "clear") {
    saveModelPicks([]);
    console.log("picks cleared — auto uses the full model list again");
    process.exit(0);
  }
  if (sub === "unpick" && args[idx + 2]) {
    const picks = loadModelPicks().filter((x) => x !== args[idx + 2]);
    saveModelPicks(picks);
    console.log(`picked: ${picks.join(", ") || "(none)"}${picks.length === 0 ? " (auto uses full list)" : ""}`);
    process.exit(0);
  }
  if (sub === "picks") {
    const picks = loadModelPicks();
    if (!picks.length) {
      console.log("no picks — auto uses the full model list");
    } else {
      console.log(`${picks.length} picked model(s), auto only selects within these:`);
    }
    for (const id of picks) console.log(`  ${id}`);
    process.exit(0);
  }
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
      const { normalizeProviderId } = await import("../../providers/model-id.js");
      const nid = normalizeProviderId(modelListProvider);
      modelListProvider = nid || modelListProvider.toLowerCase();
    }
  }
  if (sub !== undefined && sub !== "list") {
    console.error("usage: mslxdff -models (interactive multi-pick) | mslxdff -model list [--provider <id>] [--json] | mslxdff -model set <id> | mslxdff -model pick <id> | mslxdff -model unpick <id> | mslxdff -model pick clear | mslxdff -model picks | mslxdff -model status | mslxdff -model refresh");
    process.exit(1);
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
          const { loadProviderAllowedModels, loadProviderAllowAnyModels, loadProviderBaseUrl } = await import("../../state.js");
          const { loadModelAliases, getAliasForModel } = await import("../../providers/model-id.js");
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
        const { loadProviderConfigs, loadProviderAllowedModels } = await import("../../state.js");
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
    const mark = (id) => (pickedIds.includes(id) ? "*" : " ");
    const groups = {};
    for (const id of ids) {
      const prov = String(id).includes("/") ? String(id).split("/")[0] : "opencode";
      if (!groups[prov]) groups[prov] = [];
      groups[prov].push(id);
    }
    const order = ["opencode", "workbuddy", "clinebot", "openrouter"];
    const sortedProvs = Object.keys(groups).sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      if (ia !== -1 || ib !== -1) {
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      }
      return a.localeCompare(b);
    });
    if (modelListProvider) {
      console.log(`${ids.length} model(s) for ${modelListProvider}${at} (${pickedIds.length} picked, * = picked):`);
      let aliasMap = {};
      try {
        const { loadModelAliases, getAliasForModel } = await import("../../providers/model-id.js");
        loadModelAliases();
        for (const id of ids) {
          const alias = getAliasForModel(id);
          if (alias) aliasMap[id] = alias;
          else if (String(id).includes("/")) {
            const dashAlias = String(id).replace(/\//g, "-");
            if (dashAlias !== id) aliasMap[id] = dashAlias;
          }
        }
      } catch {}
      for (const prov of sortedProvs) {
        const list = groups[prov];
        console.log(`\n  ── ${prov} (${list.length}) ──`);
        for (const id of list) {
          const alias = aliasMap[id];
          const aliasStr = alias ? `  (别名: ${alias})` : "";
          console.log(`  ${mark(id)} ${id}${aliasStr}`);
        }
      }
      console.log(`\npicked only constrains auto; manage with: mslxdff -models (TTY) | mslxdff -model pick <id> | mslxdff -model unpick <id> | mslxdff -model pick clear`);
    } else {
      console.log(`${ids.length} free model(s)${at} (${pickedIds.length} picked, * = picked):`);
      let aliasMap = {};
      let fullAliases = {};
      try {
        const { loadModelAliases, getAliasForModel } = await import("../../providers/model-id.js");
        loadModelAliases();
        for (const id of ids) {
          const alias = getAliasForModel(id);
          if (alias) aliasMap[id] = alias;
          else if (String(id).includes("/")) {
            const dashAlias = String(id).replace(/\//g, "-");
            if (dashAlias !== id) aliasMap[id] = dashAlias;
          }
        }
        try {
          const aliasesFile = join(homedir(), ".config", "mslxdff", "model-aliases.json");
          const raw = JSON.parse(readFileSync(aliasesFile, "utf8"));
          if (raw && typeof raw === "object") fullAliases = raw;
        } catch {}
      } catch {}
      for (const prov of sortedProvs) {
        const list = groups[prov];
        console.log(`\n  ── ${prov} (${list.length}) ──`);
        for (const id of list) {
          const alias = aliasMap[id];
          const aliasStr = alias ? `  (别名: ${alias})` : "";
          console.log(`  ${mark(id)} ${id}${aliasStr}`);
        }
      }
      try {
        const { loadProviderConfigs, loadProviderAllowedModels, loadProviderAllowAnyModels, loadProviderBaseUrl } = await import("../../state.js");
        const { loadModelAliases: _la2, getAliasForModel: _gaf } = await import("../../providers/model-id.js");
        try { _la2(); } catch {}
        const configs = loadProviderConfigs();
        const otherIds = Object.keys(configs).filter((k) => String(k).toLowerCase() !== "opencode");
        const order2 = ["workbuddy", "clinebot", "openrouter", "bai"];
        otherIds.sort((a, b) => {
          const ia = order2.indexOf(a), ib = order2.indexOf(b);
          if (ia !== -1 || ib !== -1) {
            if (ia === -1) return 1;
            if (ib === -1) return -1;
            return ia - ib;
          }
          return a.localeCompare(b);
        });
        if (otherIds.length) {
          console.log(`\n────────────────────────────────────────`);
          console.log(`其他供应商 (allowlist，原名 + 别名) (${otherIds.length} providers):`);
          for (const pid of otherIds) {
            const allowed = loadProviderAllowedModels(pid);
            const allowAny = loadProviderAllowAnyModels(pid);
            const baseUrl = loadProviderBaseUrl(pid) || configs[pid]?.baseUrl || "";
            const header = allowAny
              ? (allowed.length ? `allowlist ${allowed.length} (allowAny ON)` : `allowAny ON (allowlist 空=放行全部)`)
              : (allowed.length ? `allowlist ${allowed.length} (allowAny OFF)` : `allowlist 空 + allowAny OFF = 阻塞`);
            console.log(`\n  ── ${pid} (${header})${baseUrl ? `  baseUrl=${baseUrl}` : ""} ──`);
            if (!allowed.length) {
              if (allowAny) {
                console.log(`     (未设 allowlist，全部模型放行)  查看 live 列表: mslxdff -provider ${pid} models`);
                console.log(`     限制可用模型: mslxdff -provider ${pid} allowlist set <model1> <model2>`);
              } else {
                console.log(`     阻塞中：无可用模型 — 设白名单: mslxdff -provider ${pid} allowlist set <model1> <model2>`);
                console.log(`     或放行全部: mslxdff -provider ${pid} allowAny on`);
              }
            } else {
              for (const raw of allowed) {
                const canonical = `${pid}/${raw}`;
                let alias = null;
                try { alias = _gaf(canonical); } catch {}
                if (!alias && String(canonical).includes("/")) alias = String(canonical).replace(/\//g, "-");
                const aliasStr = alias && alias !== canonical ? `  (别名: ${alias})` : "";
                const pickedMark = pickedIds.includes(canonical) || pickedIds.includes(alias || "") ? "*" : " ";
                console.log(`     ${pickedMark} ${canonical}${aliasStr}`);
              }
              console.log(`     管理: mslxdff -provider ${pid} allowlist [list|add|remove|clear] | allowAny on|off`);
            }
          }
        } else {
          console.log(`\n────────────────────────────────────────`);
          console.log(`其他供应商 (allowlist，原名 + 别名): (none — 尚未配置)`);
          console.log(`  添加示例: mslxdff -provider add myapi https://api.example.com/v1 sk-xxx --models-path /v1/models`);
        }
        const aliasEntries = Object.entries(fullAliases).filter(([alias, canonical]) => {
          if (ids.includes(canonical)) return false;
          for (const pid of otherIds) {
            const allowed = loadProviderAllowedModels(pid);
            for (const raw of allowed) {
              const can = `${pid}/${raw}`;
              if (can === canonical) return false;
            }
          }
          return true;
        });
        if (aliasEntries.length) {
          console.log(`\n  本地别名 (不在 allowlist 里的遗留映射 ${aliasEntries.length}):`);
          for (const [alias, canonical] of aliasEntries) {
            console.log(`     ${canonical}  =>  ${alias}`);
          }
        }
      } catch {}
      console.log(`\npicked only constrains auto; manage with: mslxdff -models (TTY) | mslxdff -model pick <id> | mslxdff -model unpick <id> | mslxdff -model pick clear`);
    }
  } catch (err) {
    console.error(`could not fetch models: ${String(err?.message || err)}`);
    process.exit(1);
  }
  process.exit(0);
}
