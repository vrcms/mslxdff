import { join } from "node:path";
import { loadToken, getPort, savePreferredModel, loadPreferredModel } from "../../state.js";
import { getPreferredModel as getPref } from "../../auto.js";
import { normalizeModel } from "../../reasoning.js";
import { syncToWorkbuddy, workbuddyModelsPath } from "../../sync-workbuddy.js";
import { syncToOpencode, opencodeConfigPath, toExternalAlias, toInternalId } from "../../sync-opencode.js";
import { createModelsService } from "../../models.js";
import { createUpstreamClient } from "../../upstream.js";
import { logDir } from "../../logs.js";

export async function handleSetto(args) {
  if (!(args.includes("-setto") || args.includes("--setto"))) return false;
  const idx = args.findIndex((x) => x === "-setto" || x === "--setto");
  const target = args[idx + 1];
  if (!["workbuddy", "opencode"].includes(target)) {
    console.error("usage: mslxdff -setto workbuddy [modelId] | mslxdff -setto opencode [modelId]");
    process.exit(1);
  }
  if (target === "opencode") {
    const raw = args[idx + 2] && !String(args[idx + 2]).startsWith("-") ? String(args[idx + 2]).trim() : null;
    let id;
    let internal;
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
      internal = toInternalId(norm);
      id = toExternalAlias(internal);
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
      internal = toInternalId(norm);
      id = toExternalAlias(internal);
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
        if (!ids.includes(internal) && !ids.includes(id)) {
          console.log(`warn: "${internal}" not in current free list (${ids.length} models), still syncing to opencode (alias ${id})`);
        }
      }
    } catch {}
    try {
      const { token } = await loadToken();
      const persisted = getPort();
      const envPort = Number(process.env.MSLXDFF_PORT);
      const port = persisted !== null ? persisted : (Number.isInteger(envPort) && envPort > 0 ? envPort : 8989);
      const file = opencodeConfigPath();
      const r = await syncToOpencode({ id, token, port, file });
      const aliasLabel = r.alias && r.alias !== r.id ? ` (alias ${r.alias} 对应内部 ${r.internal})` : (r.id !== r.internal ? ` (alias for "${r.internal}", 原名仍兼容)` : ` (原名兼容)`);
      console.log(`synced to opencode: ${r.action} "${r.id}"${aliasLabel} @ ${file}`);
      console.log(`  url: http://127.0.0.1:${port}/v1`);
      if (r.id !== r.internal) console.log(`  alias: ${r.id} -> ${r.internal} (opencode 选 mslxdff/${r.id} 直达本地 ${r.internal})`);
      else console.log(`  alias: ${r.internal} (原名直用，opencode 选 mslxdff/${r.id} 直达本地 ${r.internal})`);
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
    const r = await syncToWorkbuddy({ id, token, port, file });
    console.log(`synced to WorkBuddy: ${r.action} "${id}" @ ${file}`);
    console.log(`  url: http://127.0.0.1:${port}/v1/chat/completions`);
  } catch (err) {
    console.error(`failed to sync to WorkBuddy: ${String(err?.message || err)}`);
    process.exit(1);
  }
  process.exit(0);
}
