// `-models` / `-model list` 展示排序：opencode free 优先 → 其余供应商分组 → 组内字母序。
// 单一来源：本文件被 list.js（交互候选）与 list-render.js（分组渲染）共用。
// Note: 排序只影响展示顺序，不改 picks/候选集合 — 见 .agents/notes/implemented/feature/2026-09-28-models-sort-opencode-free-first.md
import { isFreeModel } from "../../../models.js";

/** 供应商展示优先级（opencode 恒第一；未知供应商按字母序排其后） */
export const PROVIDER_ORDER = ["opencode", "workbuddy", "cline", "openrouter", "qoder", "codearts", "traework", "bai"];

/** 取模型 id 的供应商前缀；无斜杠的裸 id 归 opencode */
export function providerOf(id) {
  const s = String(id || "");
  const i = s.indexOf("/");
  return i > 0 ? s.slice(0, i).toLowerCase() : "opencode";
}

/** 供应商排序权重：opencode=0，已知供应商=其序号+1，未知=大数（按字母序兜底） */
export function providerRank(prov) {
  const i = PROVIDER_ORDER.indexOf(prov);
  return i === -1 ? PROVIDER_ORDER.length : i;
}

/**
 * 模型 id 排序比较器：
 *  1) opencode free（isFreeModel）最前 —— 用户主诉求
 *  2) opencode 非 free 次之
 *  3) 其余供应商按 PROVIDER_ORDER，未知按字母序
 *  4) 同段内 localeCompare 字母序（大小写不敏感兜底）
 */
export function compareModelIds(a, b) {
  const pa = providerOf(a);
  const pb = providerOf(b);
  const fa = pa === "opencode" && isFreeModel(a);
  const fb = pb === "opencode" && isFreeModel(b);
  // 段位：0=opencode free，1=opencode 其他，2=其他供应商
  const ga = fa ? 0 : pa === "opencode" ? 1 : 2;
  const gb = fb ? 0 : pb === "opencode" ? 1 : 2;
  if (ga !== gb) return ga - gb;
  if (ga === 2) {
    const ra = providerRank(pa);
    const rb = providerRank(pb);
    if (ra !== rb) return ra - rb;
    if (pa !== pb) return pa.localeCompare(pb);
  }
  const la = String(a).toLowerCase();
  const lb = String(b).toLowerCase();
  return la === lb ? String(a).localeCompare(String(b)) : la.localeCompare(lb);
}

/** 返回排序后的新数组（不改原数组） */
export function sortModelIds(ids) {
  return [...(ids || [])].sort(compareModelIds);
}
