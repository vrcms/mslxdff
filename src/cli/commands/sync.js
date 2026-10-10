import { join } from "node:path";
import { loadToken, getPort, savePreferredModel, loadPreferredModel, loadModelPicks } from "../../state.js";
import { getPreferredModel as getPref } from "../../auto.js";
import { normalizeModel } from "../../reasoning.js";
import { syncToWorkbuddy, workbuddyModelsPath } from "../../sync-workbuddy.js";
import { syncToOpencode, opencodeConfigPath } from "../../sync-opencode.js";
import { syncToCodex, codexConfigPath } from "../../sync-codex.js";
import { syncToClaude, claudeSettingsPath } from "../../sync-claude.js";
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
  if (!["workbuddy", "opencode", "chatgpt", "codex", "claude", "claude-desktop", "claudedesktop"].includes(target)) {
    console.error("usage: mslxdff -setto workbuddy [modelId] | mslxdff -setto opencode [modelId|--all] | mslxdff -setto chatgpt [modelId] | mslxdff -setto claude [modelId] [--behaves-as <id>] | mslxdff -setto claude-desktop [modelId ...] [--max N] [--no-alias] [--check] [--official]  (claude: 不带 modelId = 写入 modelPicks 勾选集全集，--all 与之同义 / claude-desktop: 写 Claude Desktop 3P profile + 角色槽 alias)");
    process.exit(1);
  }
  if (target === "claude-desktop" || target === "claudedesktop") {
    // Claude Desktop on 3P（ADR-0048）：写 profile + 角色槽 alias。sync.js 只做转发——
    // 本文件已近 20KB 体积门，实现放 src/cli/commands/claude-desktop.js。
    const { handleClaudeDesktopSetto } = await import("./claude-desktop.js");
    return handleClaudeDesktopSetto(args, idx);
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
  if (target === "claude") {
    // Claude Code 用户设置 ~/.claude/settings.json：走本机 /v1/messages 外壳（ADR-0047）
    // 参数校验一律先于任何写盘（含 savePreferredModel）：校验不过不得碰 state.json 与 settings.json
    // --behaves-as <已知 claude-* id> 覆盖能力锚；`--behaves-as ""` 显式关掉（关掉后本机 Claude Code 可能对未知 id 拒跑）
    const baIdx = args.findIndex((x) => x === "--behaves-as");
    if (baIdx >= 0 && args[baIdx + 1] === undefined) {
      console.error("--behaves-as 需要取值：给一个已知 claude-* id，或显式传空串关闭（--behaves-as \"\"）");
      process.exit(1);
    }
    const behavesAs = baIdx >= 0 ? String(args[baIdx + 1]) : undefined;
    const raw = args[idx + 2] && !String(args[idx + 2]).startsWith("-") && args[idx + 2] !== "all" ? String(args[idx + 2]).trim() : null;
    const picksAll = loadModelPicks();
    let id;
    let batch = false;
    if (raw) {
      if (raw === "auto" || !normalizeModel(raw)) {
        console.error("modelId 不能为 auto 或空");
        process.exit(1);
      }
      const norm = normalizeModel(raw);
      if (!norm) {
        console.error("modelId 不能为空");
        process.exit(1);
      }
      if (picksAll.length && !picksAll.includes(norm)) {
        console.log(`  ⚠ "${norm}" 不在勾选集 modelPicks 内 —— 可能是拼错或已失效；仍按你显式指定的写入`);
      }
      savePreferredModel(norm);
      console.log(`default model set to: ${norm} (daemon hot-reloads on next request)`);
      id = norm;
    } else {
      // 不带参数（含 --all / 裸 all）= 写入全部勾选模型：modelPicker.options = modelPicks 全集，
      // 顶层 model 也只在勾选集内取。**不再兜底 preferredModel** —— 它可能是一个已从池子消失的 id
      // （真实踩坑：preferredModel=mimo-v2.5-free 被写进 Claude Code 后，每次请求只会得到 502）。
      batch = true;
      if (!picksAll.length) {
        console.error("modelPicks 勾选集为空 → 无可写入的模型；先跑 mslxdff -model pick 勾选，或直接 mslxdff -setto claude <modelId>");
        process.exit(1);
      }
      const pref = normalizeModel(loadPreferredModel() || getPref() || "");
      if (pref && picksAll.includes(pref)) {
        id = pref;
      } else {
        if (pref) console.log(`  ⚠ 网关首选模型 "${pref}" 不在勾选集内（可能已失效）→ claude 默认改用勾选集首个 "${picksAll[0]}"`);
        id = normalizeModel(picksAll[0]);
      }
    }
    try {
      const { token } = await loadToken();
      const persisted = getPort();
      const envPort = Number(process.env.MSLXDFF_PORT);
      const port = persisted !== null ? persisted : (Number.isInteger(envPort) && envPort > 0 ? envPort : 8989);
      // options 由本命令全权管理：默认/`--all` 用勾选集整体替换，显式单模型则只留一条。
      const picks = batch ? picksAll : null;
      const file = claudeSettingsPath();
      const r = syncToClaude({ id, token, port, picks, file, behavesAs });
      console.log(`synced to claude: ${r.action} "${r.id}" @ ${r.file}${r.changed ? "" : "（已是目标状态，未改字节）"}`);
      if (r.backup) { console.log(`  backup: ${r.backup}`); console.log(`  还原: Copy-Item "${r.backup}" "${r.file}"`); }
      else console.log(`  backup: 未生成（本次无变化，或同目录已有更早的 settings.pre-mslxdff.json —— 那份是首次接管前的原文）`);
      if (r.tmpLeftover) console.error(`  ⚠ 临时文件清理失败：${r.tmpLeftover}（内含明文 token，请手动删除）`);
      console.log(`  url: http://127.0.0.1:${port}  （不带 /v1 —— Claude Code 自己拼 /v1/messages）`);
      console.log(`  modelPicker: ${r.rows} 行${batch ? "（勾选集全集）" : "（单模型）"}`);
      console.log(`  冒烟: curl -H "Authorization: Bearer $(mslxdff -showtoken)" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" -d '{"model":"${r.id}","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}' http://127.0.0.1:${port}/v1/messages  （max_tokens 别给太小：思考型模型会把额度全花在 reasoning 上而吐空正文轮）`);
      console.log(`  ⚠ env 与 model 均为 Claude Code 启动时读取 → 重启 claude 生效；token 轮换后需重跑本命令`);
      console.log(`  ℹ 客户端不认识的模型 id 一律按 200K 窗口假设（带 \`[1m]\` 后缀才按 1M），需要更大窗口另设 env.CLAUDE_CODE_MAX_CONTEXT_TOKENS`);
    } catch (err) {
      console.error(`failed to sync to claude: ${String(err?.message || err)}`);
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
          const r = await syncToOpencode({ id: norm, token, port, file, keep: pruneKeep(), ensureAll: pruneKeep() });
          if (r.action === "inserted") inserted++; else updated++;
          prunedTotal += r.pruned || 0;
          console.log(`  ${r.action} "${r.id}" -> ${r.internal} @ ${file}`);
          if (r.capsSummaryText) console.log(`      ${r.capsSummaryText}`);
          if (r.upgraded) console.log(`      能力补齐 ${r.upgraded} 个旧条目`);
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
      const r = await syncToOpencode({ id, token, port, file, keep: pruneKeep(), ensureAll: pruneKeep() });
      console.log(`synced to opencode: ${r.action} "${r.id}" @ ${file}`);
      if (r.capsSummaryText) console.log(`  能力: ${r.capsSummaryText}`);
      else console.log(`  能力: 未收录该模型的能力目录，条目仅含名称（不影响使用）`);
      if (r.upgraded) console.log(`  能力补齐 ${r.upgraded} 个旧条目（此前仅含名称，已注入推理档位/读图/上下文）`);
      if (r.backfilled) console.log(`  backfilled ${r.backfilled} 个 picks 模型（此前 pick 了但未同步过，现已补齐）`);
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
