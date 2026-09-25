/**
 * Cline 白名单自动同步（上游列表 = 真相）。
 *
 * 背景：`providerConfigs.cline.allowedModels` 是一份**静态快照**（历史由 `-provider cline free sync --yes` 一次性写入）。
 * 上游 `recommended-models` 会漂移——新模型上架免费通道、同一模型从 `cline-pass/` 挪到 `cline-free/`——
 * 而静态快照不跟着变，于是 `isModelAllowed()` 精确匹配失败，把上游明明免费可用的模型当成"未授权"拦掉
 * （实测 2026-09-24：`cline-free/gemini-3.8-flash`、`stealth/space-bunny-alpha`、`cline-free/mimo-v2.6-flash` 被拦，
 *  而 allowlist 里只有 `cline-pass/mimo-v2.6-flash`，通道不同即视为不同 id）。
 *
 * 本模块把语义改成「每次成功读取上游列表后，立即把上游 id 并进白名单」：
 *   - **只增不减**：上游下架的 id 保留在表内（与 modelPicks 孤儿"仅标记不自动删"的既有口径一致，回收走 prune），
 *     避免同步动作变成删配置。
 *   - **仅在上游成功路径调用**：内置兜底常量不是上游真相，写盘只会污染（由调用方保证，见 models.js）。
 *   - **无新增不写盘**：上游 10 分钟缓存内反复命中同一列表时零写放大。
 * 关掉：`MSLXDFF_CLINE_AUTOSYNC=0`（退回纯静态白名单行为）。
 * Note: 只增不减 + 仅上游成功路径同步的取舍见 .agents/notes/implemented/feature/2026-09-24-cline-auto-sync-free-catalog.md
 *
 * 纯逻辑（planMerge）无 IO，可单测；IO 全走注入。
 */

/** 与 state/provider-config.js 的 normalizeAllowedModel 对齐：只剥首段等于 providerId 的前缀。调用方可注入同名函数保证单一真相。 */
export function defaultNormalize(model, providerId) {
  let s = String(model || "").trim();
  if (!s) return "";
  const idx = s.indexOf("/");
  if (idx > 0 && s.slice(0, idx).toLowerCase() === String(providerId || "").toLowerCase()) s = s.slice(idx + 1);
  return s;
}

/**
 * 求并集：保留 current 原顺序与全部既有条目，把 upstreamIds 中缺失的追加到尾部。
 * @param {string[]} current 当前白名单（裸 id）
 * @param {string[]} upstreamIds 上游模型 id（可带 provider 前缀，内部归一）
 * @param {(m:string, pid:string)=>string} [normalize]
 * @param {string} [providerId]
 * @returns {{next:string[], added:string[]}}
 */
export function planMerge(current, upstreamIds, normalize = defaultNormalize, providerId = "") {
  const cur = Array.isArray(current) ? current : [];
  const next = [...new Set(cur.map((m) => normalize(m, providerId)).filter(Boolean))];
  const seen = new Set(next);
  const added = [];
  for (const raw of Array.isArray(upstreamIds) ? upstreamIds : []) {
    const norm = normalize(raw, providerId);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    next.push(norm);
    added.push(norm);
  }
  return { next, added };
}

/**
 * @param {object} opts
 * @param {string} opts.providerId
 * @param {() => string[]} opts.loadCurrent 读当前白名单（裸 id 数组）
 * @param {(id:string, list:string[]) => unknown} opts.persist 写回白名单
 * @param {(msg:string) => void} [opts.onLog]
 * @param {(m:string, pid:string)=>string} [opts.normalize]
 * @param {boolean} [opts.enabled] 显式覆盖 env 开关
 */
export function createAllowlistSync({ providerId, loadCurrent, persist, onLog, normalize = defaultNormalize, enabled } = {}) {
  const isEnabled = () => {
    if (typeof enabled === "boolean") return enabled;
    return String(process.env.MSLXDFF_CLINE_AUTOSYNC ?? "") !== "0";
  };
  const log = (msg) => { try { onLog?.(msg); } catch {} };

  /**
   * 把一批上游模型并进白名单。
   * @param {{id?:string}[]|string[]} models 上游模型对象数组或 id 数组
   * @returns {{skipped:string, added:string[], total:number}}
   */
  function syncIds(models) {
    if (!isEnabled()) return { skipped: "disabled", added: [], total: 0 };
    if (!Array.isArray(models) || !models.length) return { skipped: "empty", added: [], total: 0 };
    try {
      const ids = models.map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean);
      const cur = loadCurrent() || [];
      const { next, added } = planMerge(cur, ids, normalize, providerId);
      if (!added.length) return { skipped: "", added: [], total: next.length };
      persist(providerId, next);
      log(`[${providerId}] allowlist auto-sync: +${added.length} → ${next.length} total (${added.join(", ")})`);
      return { skipped: "", added, total: next.length };
    } catch (err) {
      // 同步是增益动作，失败绝不打断模型列表读取与请求链路
      log(`[${providerId}] allowlist auto-sync failed: ${String(err?.message || err)}`);
      return { skipped: "error", added: [], total: 0 };
    }
  }

  return { syncIds };
}
