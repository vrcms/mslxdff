import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** 构建 id → 别名映射（原 list 两处重复逻辑收敛） */
export function buildAliasMap(ids, getAliasForModel) {
  const aliasMap = {};
  for (const id of ids) {
    const alias = getAliasForModel(id);
    if (alias) aliasMap[id] = alias;
    else if (String(id).includes("/")) {
      const dashAlias = String(id).replace(/\//g, "-");
      if (dashAlias !== id) aliasMap[id] = dashAlias;
    }
  }
  return aliasMap;
}

/** 读本地别名全表（遗留映射展示用） */
export function readFullAliases() {
  try {
    const aliasesFile = join(homedir(), ".config", "mslxdff", "model-aliases.json");
    const raw = JSON.parse(readFileSync(aliasesFile, "utf8"));
    if (raw && typeof raw === "object") return raw;
  } catch {}
  return {};
}

/** `--provider <id>` 分支的分组渲染 */
export function renderProviderList({ ids, at, pickedIds, modelListProvider, sortedProvs, groups, aliasMap }) {
  console.log(`${ids.length} model(s) for ${modelListProvider}${at} (${pickedIds.length} picked, * = picked):`);
  const mark = (id) => (pickedIds.includes(id) ? "*" : " ");
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
}

/** 全量 free 列表的分组渲染 */
export function renderFreeList({ ids, at, pickedIds, sortedProvs, groups, aliasMap }) {
  console.log(`${ids.length} free model(s)${at} (${pickedIds.length} picked, * = picked):`);
  const mark = (id) => (pickedIds.includes(id) ? "*" : " ");
  for (const prov of sortedProvs) {
    const list = groups[prov];
    console.log(`\n  ── ${prov} (${list.length}) ──`);
    for (const id of list) {
      const alias = aliasMap[id];
      const aliasStr = alias ? `  (别名: ${alias})` : "";
      console.log(`  ${mark(id)} ${id}${aliasStr}`);
    }
  }
}

/** 按供应商分组 + 排序（opencode/workbuddy/clinebot/openrouter 优先） */
export function groupByProvider(ids) {
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
  return { groups, sortedProvs };
}
