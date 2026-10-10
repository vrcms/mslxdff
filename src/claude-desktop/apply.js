import { normalizeModel } from "../reasoning.js";
import { registerModelAlias, persistModelAliases, loadModelAliases, modelAliasFile } from "../providers/model-id.js";
import { planSlots, aliasPairs, ROLE_SLOTS } from "./slots.js";
import { syncToClaudeDesktop, retireClaudeDesktopProfile, claudeDesktopConfigDir } from "../sync-claude-desktop.js";
import { detectManagedPolicy, currentAliases, probeMessages } from "./doctor.js";

/**
 * `-setto claude-desktop` 的编排层（副作用集中在这一个文件，CLI 只管参数与人话输出）。
 * 一次调用做两件事，缺一不可 —— 这正是社区工具要「profile + 本地路由」两步的原因：
 *  ① 写 Claude Desktop 的 3P profile（`inferenceModels` 用**角色槽 id**，`labelOverride` 标真模型名）；
 *  ② 写网关自己的 alias（角色槽 → 真模型），让桌面端发来的槽位请求在入站就被翻译成能跑的真模型。
 * 少了 ②，桌面端每次请求都会被当未知模型丢组员转发 → 30~90 s 后 502（App 里就表现为 Test connection 红点）。
 */
export async function applyClaudeDesktop({ picks = [], preferred = "", port = 8989, token = "", max, maxEffort, noAlias = false, dir, probe = false, probeTimeoutMs = 90000 } = {}) {
  const planned = planSlots({ picks, preferred, max });
  const rows = planned.rows.map((r) => ({ ...r, model: normalizeModel(r.model) || r.model }));
  const written = syncToClaudeDesktop({ port, token, rows, maxEffort, dir: dir || claudeDesktopConfigDir() });

  const out = {
    dir: written.dir,
    configFile: written.configFile,
    metaFile: written.metaFile,
    configId: written.id,
    action: written.action,
    changed: written.changed,
    backups: written.backups || [],
    tmpLeftover: written.tmpLeftover || [],
    rows,
    overflow: planned.overflow,
    dropped: planned.dropped,
    slotCap: ROLE_SLOTS.length,
    aliasFile: modelAliasFile(),
    aliasAdded: [],
    aliasOverwritten: [],
    aliasSkipped: noAlias,
    managed: detectManagedPolicy(),
    probes: [],
  };

  if (!noAlias) {
    const before = currentAliases();
    for (const [slot, model] of aliasPairs(rows)) {
      if (before[slot] && before[slot] !== model) out.aliasOverwritten.push({ slot, from: before[slot], to: model });
      else out.aliasAdded.push({ slot, to: model });
      registerModelAlias(slot, model);
    }
    persistModelAliases();
  }

  if (probe) {
    for (const r of rows) out.probes.push(await probeMessages({ port, token, model: r.slot, timeoutMs: probeTimeoutMs }));
  }
  return out;
}

/** `--official`：摘掉 mslxdff 那条登记（不删配置、不动别人的 entry）。 */
export function retireClaudeDesktop({ port = 8989, dir, alsoAliases = [] } = {}) {
  const r = retireClaudeDesktopProfile({ port, dir: dir || claudeDesktopConfigDir() });
  const aliasFile = modelAliasFile();
  return { ...r, aliasFile, aliasHints: Array.isArray(alsoAliases) ? alsoAliases : [] };
}

/** 现成 alias 表（给 CLI 报「哪些槽位被谁占着」）。 */
export { loadModelAliases };
