import { join } from "node:path";
import { createModelsService } from "../../models.js";
import { createUpstreamClient } from "../../upstream.js";
import { logDir } from "../../logs.js";
import { handleModelStatus } from "./model/status.js";
import { handleModelStats } from "./model/stats.js";
import { handlePicksCommand } from "./model/picks.js";
import { handleModelList } from "./model/list.js";

/**
 * `-model` 门面 — 仅分发：refresh 直连，status/stats/picks/list 下沉子模块。
 * 对外接缝 `handleModel(args)` 不变（src/cli/index.js 动态 import）。
 */
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
    await handleModelStatus(args);
    return true;
  }
  if (sub === "stats") {
    await handleModelStats(args);
    return true;
  }
  if (await handlePicksCommand(args, idx, sub)) return true;
  if (sub !== undefined && sub !== "list") {
    console.error("usage: mslxdff -models (interactive multi-pick) | mslxdff -model list [--provider <id>] [--json] | mslxdff -model set <id> | mslxdff -model pick <id> | mslxdff -model unpick <id> | mslxdff -model pick clear | mslxdff -model picks | mslxdff -model status [--all] | mslxdff -model stats [--all] | mslxdff -model refresh");
    process.exit(1);
  }
  await handleModelList(args, idx, sub);
  return true;
}
