import { join } from "node:path";
import { loadToken, getPort, savePreferredModel, loadPreferredModel, loadModelPicks } from "../../state.js";
import { getPreferredModel as getPref } from "../../auto.js";
import { normalizeModel } from "../../reasoning.js";
import { syncToWorkbuddy, workbuddyModelsPath } from "../../sync-workbuddy.js";
import { syncToOpencode, opencodeConfigPath } from "../../sync-opencode.js";
import { syncToCodex, codexConfigPath } from "../../sync-codex.js";
import { createModelsService } from "../../models.js";
import { createUpstreamClient } from "../../upstream.js";
import { logDir } from "../../logs.js";

// 剪枝口径：picks 非空时，未在 picks 的旧模型视为失效，下次 setto 从第三方配置里摘除；
// picks 为空（=不筛选）时返回 null，sync 侧一个不动。
function pruneKeep() {
  const picks = loadModelPicks();
  return picks.length ? picks : null;
}

export async function handleSetto(args) {
  if (!(args.includes("-setto") || args.includes("--setto"))) return false;
  const idx = args.findIndex((x) => x === "-setto" || x === "--setto");
  const target = args[idx + 1];
  if (!["workbuddy", "opencode", "chatgpt", "codex"].includes(target)) {
    console.error("usage: mslxdff -setto workbuddy [modelId] | mslxdff -setto opencode [modelId|--all] | mslxdff -setto chatgpt [modelId]");
    process.exit(1);
  }
  if (target === "chatgpt" || target === "codex") {
    // Codex/ChatGPT 三端共用 ~/.codex/config.toml：写 model + model_provider + [model_providers.mslxdff]
    const raw = args[idx + 2] && !String(args[idx + 2]).startsWith("-") ? String(args[idx + 2]).trim() : null;
    let id;
    if (raw) {
      if (raw === "auto" || !raw) {
        console.error("modelId 不能为 auto 或空");
        process.exit(1);
      }
      const norm = normalizeModel(raw);
      if (!norm) {
        console.error("modelId 不能为空");
        process.exit(1);
      }
      savePreferredModel(norm);
      console.log(`default model set to: ${norm} (daemon hot-reloads on next request)`);
      id = norm;
    } else {
      id = loadPreferredModel() || getPref();
      if (!id) {
        console.error("no preferred model set; use: mslxdff -setto chatgpt <modelId>");
        process.exit(1);
      }
    }
    try {
      const persisted = getPort();
      const envPort = Number(process.env.MSLXDFF_PORT);
      const port = persisted !== null ? persisted : (Number.isInteger(envPort) && envPort > 0 ? envPort : 8989);
      const file = codexConfigPath();
      const r = syncToCodex({ id, port, file });
      console.log(`synced to codex: ${r.action} "${r.id}" @ ${r.file}`);
      console.log(`  url: http://127.0.0.1:${port}/v1/responses (Responses API)`);
      console.log(`  鉴权走 mslxdff -showtoken 命令（token 不落盘），直接 codex exec "hi" 验证`);
    } catch (err) {
      console.error(`failed to sync to codex: ${String(err?.message || err)}`);
      process.exit(1);
    }
    process.exit(0);
  }
  if (target === "opencode") {
    const wantsAll = args.includes("--all") || args.includes("-a") || args[idx + 2] === "all";
    if (wantsAll) {
      const picks = loadModelPicks();
      const list = picks.length ? picks : [loadPreferredModel() || getPref()].filter(Boolean);
      if (!list.length) {
        console.error("no picks and no preferred model; use: mslxdff -setto opencode <modelId>");
        process.exit(1);
      }
      try {
        const { token } = await loadToken();
        const persisted = getPort();
        const envPort = Number(process.env.MSLXDFF_PORT);
        const port = persisted !== null ? persisted : (Number.isInteger(envPort) && envPort > 0 ? envPort : 8989);
        const file = opencodeConfigPath();
        let inserted = 0, updated = 0, prunedTotal = 0;
        for (const rawId of list) {
          const norm = normalizeModel(rawId);
          if (!norm || norm === "auto") continue;
          // 首次循环也同步 preferred（保持 daemon 热重载语义）
          if (rawId === list[0]) savePreferredModel(norm);
          const r = await syncToOpencode({ id: norm, token, port, file, keep: pruneKeep() });
          if (r.action === "inserted") inserted++; else updated++;
          prunedTotal += r.pruned || 0;
          console.log(`  ${r.action} "${r.id}" -> ${r.internal} @ ${file}`);
        }
        console.log(`synced to opencode: ${inserted} inserted, ${updated} updated, total ${list.length} @ ${file}`);
        if (prunedTotal) console.log(`  pruned ${prunedTotal} 个失效模型（未在 picks，不再于 opencode 显示）`);
        console.log(`  url: http://127.0.0.1:${port}/v1`);
        console.log(`  models: ${list.map((x) => normalizeModel(x)).join(", ")}`);
        console.log(`  opencode 选 mslxdff/<model> 直达本地，同名如 mslxdff/deepseek-v4-flash-free 或 mslxdff/bai-deepseek-v4-flash`);
      } catch (err) {
        console.error(`failed to sync to opencode: ${String(err?.message || err)}`);
        process.exit(1);
      }
      process.exit(0);
    }
    const raw = args[idx + 2] && !String(args[idx + 2]).startsWith("-") ? String(args[idx + 2]).trim() : null;
    let id;
    if (raw) {
      if (raw === "auto" || !raw) {
        console.error("modelId 不能为 auto 或空");
        process.exit(1);
      }
      const norm = normalizeModel(raw);
      if (!norm) {
        console.error("modelId 不能为空");
        process.exit(1);
      }
      savePreferredModel(norm);
      console.log(`default model set to: ${norm} (daemon hot-reloads on next request)`);
      id = norm;
    } else {
      const pref = loadPreferredModel() || getPref();
      if (!pref) {
        console.error("no preferred model set; use: mslxdff -setto opencode <modelId>");
        process.exit(1);
      }
      const norm = normalizeModel(pref);
      if (!norm) {
        console.error("modelId 不能为空");
        process.exit(1);
      }
      id = norm;
    }
    // 可选：校验是否在 free 列表
    try {
      const cacheFile = join(logDir(), "models.json");
      const models = createModelsService({
        baseUrl: process.env.UPSTREAM_BASE_URL || "https://opencode.ai",
        headers: createUpstreamClient({}).headers,
        refreshMs: 0,
        cacheFile,
      });
      const fresh = await Promise.race([
        models.get(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("refresh timeout")), 4000)),
      ]);
      if (fresh?.data?.length) {
        const ids = fresh.data.map((m) => m.id);
        // 对 slash 形态也做 dash 兼容检查
        const dashId = id.includes("/") ? id.replace(/\//g, "-") : id;
        if (!ids.includes(id) && !ids.includes(dashId)) {
          console.log(`warn: "${id}" not in current free list (${ids.length} models), still syncing to opencode`);
        }
      }
    } catch {}
    try {
      const { token } = await loadToken();
      const persisted = getPort();
      const envPort = Number(process.env.MSLXDFF_PORT);
      const port = persisted !== null ? persisted : (Number.isInteger(envPort) && envPort > 0 ? envPort : 8989);
      const file = opencodeConfigPath();
      const r = await syncToOpencode({ id, token, port, file, keep: pruneKeep() });
      console.log(`synced to opencode: ${r.action} "${r.id}" @ ${file}`);
      if (r.pruned) console.log(`  pruned ${r.pruned} 个失效模型（未在 picks，不再于 opencode 显示）`);
      console.log(`  url: http://127.0.0.1:${port}/v1`);
      console.log(`  opencode 选 mslxdff/${r.id} 直达本地 ${r.internal}${r.storageKey !== r.internal ? ` (dash→${r.internal} 自动映射)` : ""}`);
    } catch (err) {
      console.error(`failed to sync to opencode: ${String(err?.message || err)}`);
      process.exit(1);
    }
    process.exit(0);
  }
  const raw = args[idx + 2] && !String(args[idx + 2]).startsWith("-") ? String(args[idx + 2]).trim() : null;
  let id;
  if (raw) {
    if (raw === "auto" || !raw) {
      console.error("modelId 不能为 auto 或空");
      process.exit(1);
    }
    const norm = normalizeModel(raw);
    if (!norm) {
      console.error("modelId 不能为空");
      process.exit(1);
    }
    savePreferredModel(norm);
    console.log(`default model set to: ${norm} (daemon hot-reloads on next request)`);
    id = norm;
  } else {
    id = loadPreferredModel() || getPref();
    if (!id) {
      console.error("no preferred model set; use: mslxdff -setto workbuddy <modelId>");
      process.exit(1);
    }
  }
  try {
    const cacheFile = join(logDir(), "models.json");
    const models = createModelsService({
      baseUrl: process.env.UPSTREAM_BASE_URL || "https://opencode.ai",
      headers: createUpstreamClient({}).headers,
      refreshMs: 0,
      cacheFile,
    });
    const fresh = await Promise.race([
      models.get(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("refresh timeout")), 4000)),
    ]);
    if (fresh?.data?.length) {
      const ids = fresh.data.map((m) => m.id);
      if (!ids.includes(id)) {
        console.log(`warn: "${id}" not in current free list (${ids.length} models), still syncing to WorkBuddy`);
      }
    }
  } catch {}
  try {
    const { token } = await loadToken();
    const persisted = getPort();
    const envPort = Number(process.env.MSLXDFF_PORT);
    const port = persisted !== null ? persisted : (Number.isInteger(envPort) && envPort > 0 ? envPort : 8989);
    const file = workbuddyModelsPath();
    const r = await syncToWorkbuddy({ id, token, port, file, keep: pruneKeep() });
    console.log(`synced to WorkBuddy: ${r.action} "${id}" @ ${file}`);
    if (r.pruned) console.log(`  pruned ${r.pruned} 个失效模型（未在 picks，不再于 WorkBuddy 显示）`);
    console.log(`  url: http://127.0.0.1:${port}/v1/chat/completions`);
  } catch (err) {
    console.error(`failed to sync to WorkBuddy: ${String(err?.message || err)}`);
    process.exit(1);
  }
  process.exit(0);
}
