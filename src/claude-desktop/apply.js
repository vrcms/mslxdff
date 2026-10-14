import { normalizeModel } from "../reasoning.js";
import { registerModelAlias, persistModelAliases, loadModelAliases, modelAliasFile } from "../providers/model-id.js";
import { planSlots, aliasPairs, ROLE_SLOTS, parseOneMMode, decideRows1m } from "./slots.js";
import { oneMContexts } from "./context1m.js";
import { syncToClaudeDesktop, retireClaudeDesktopProfile, claudeDesktopConfigDir, readClaudeDesktopProfile } from "../sync-claude-desktop.js";
import { detectManagedPolicy, currentAliases, probeMessages } from "./doctor.js";

/**
 * `-setto claude-desktop` 的编排层（副作用集中在这一个文件，CLI 只管参数与人话输出）。
 * 一次调用做两件事，缺一不可 —— 这正是社区工具要「profile + 本地路由」两步的原因：
 *  ① 写 Claude Desktop 的 3P profile（`inferenceModels` 用**角色槽 id**，`labelOverride` 标真模型名）；
 *  ② 写网关自己的 alias（角色槽 → 真模型），让桌面端发来的槽位请求在入站就被翻译成能跑的真模型。
 * 少了 ②，桌面端每次请求都会被当未知模型丢组员转发 → 30~90 s 后 502（App 里就表现为 Test connection 红点）。
 *  ③ `--1m` 上下文打标（ADR-0056，Claude Desktop 专用）：auto 问本机 /v1/models 拿已裁决窗口，
 *    证据缺位时**保留盘上既有标**（无证据≠负面证据）、**绝不阻塞写盘**；all/列表为用户担保；
 *    打标行经 toInferenceModels 写成对官方键 `supports1m+prefer1m`。evidence 参数是测试接缝。
 */
export async function applyClaudeDesktop({ picks = [], preferred = "", port = 8989, token = "", max, maxEffort, oneM = "auto", evidence, noAlias = false, dir, probe = false, probeTimeoutMs = 90000 } = {}) {
  const planned = planSlots({ picks, preferred, max });
  let rows = planned.rows.map((r) => ({ ...r, model: normalizeModel(r.model) || r.model }));

  const oneMMode = oneM && typeof oneM === "object" ? oneM : parseOneMMode(oneM);
  if (oneMMode.mode === "invalid") throw new Error("--1m 取值非法：只接受 off | auto | all | <逗号分隔槽位/模型id>");
  const desktopDir = dir || claudeDesktopConfigDir();
  let ev = evidence;
  let evidenceQueried = false;
  if (oneMMode.mode === "auto" && ev === undefined) {
    evidenceQueried = true;
    ev = await oneMContexts({ port, token });
  }
  // auto 的保留集：证据缺位（整体失败或该行不在目录）时沿用盘上既有 1M 标——网关停机的一轮
  // 不得把上次写好的标静默抹掉（评审 1 P1-2；读盘失败自然降级为空表=与旧行为一致，不新增失败模式）
  let preserve = null;
  if (oneMMode.mode === "auto") {
    preserve = new Map();
    const existing = readClaudeDesktopProfile({ dir: desktopDir });
    for (const m of Array.isArray(existing.profile?.inferenceModels) ? existing.profile.inferenceModels : []) {
      if (m && typeof m === "object" && m.supports1m === true && m.name) preserve.set(String(m.name).toLowerCase(), true);
    }
  }
  const decided = decideRows1m({ rows, oneM: oneMMode, contexts: ev && ev.ok ? ev.contexts : null, preserve });
  rows = decided.rows;

  const written = syncToClaudeDesktop({ port, token, rows, maxEffort, dir: desktopDir });

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
    oneM: {
      mode: oneMMode.mode,
      list: oneMMode.list || [],
      evidenceQueried,
      evidenceOk: oneMMode.mode === "auto" ? Boolean(ev && ev.ok) : null,
      evidenceReason: oneMMode.mode === "auto" && ev && !ev.ok ? String(ev.reason || "") : "",
      markedCount: rows.filter((r) => r.supports1m).length,
      preserved: decided.preserved,
      unmatched: decided.unmatched,
    },
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
