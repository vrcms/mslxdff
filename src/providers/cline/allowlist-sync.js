/**
 * Cline 白名单自动同步（上游目录 = 真相，双向收敛）。
 *
 * 背景：`providerConfigs.cline.allowedModels` 曾是静态快照，上游漂移后两种偏差都会伤人：
 *   ① 新上架/换通道的免费模型被静态快照拦成 blocked（2026-09-24 实测三例）；
 *   ② 已下架的免费模型长期赖在白名单里，调用即 `404 model not found`（2026-10-21 实测 6 例）。
 * 本模块把语义定为「**上游 free 目录即真相**」：
 *   - **双向收敛**：free 目录新增的并入，free 目录消失的移除；
 *   - **范围只有 free 通道**：`freeCatalogPrefixes`（缺省 `cline-free/…` 与其它 `-free`/`:free` 形态）
 *     是唯一可被自动移除的命名空间。`cline-pass/*`、`meta/*`、`stealth/*`、用户手填 id 一律不动——
 *     它们不在 free 目录里是正常的（目录接口本来只返回 free），移除会误删付费/手配模型。
 *   - **只在上游成功路径调用**：内置兜底常量不是上游真相，写盘只会污染（由调用方保证，见 models.js）。
 *   - **无变化不写盘**：10 分钟缓存内反复命中同一列表时零写放大。
 * 关掉：`MSLXDFF_CLINE_AUTOSYNC=0`（退回纯静态白名单行为）。
 * Note: 双向收敛的取舍见 .agents/notes/implemented/feature/2026-09-24-cline-auto-sync-free-catalog.md 与 docs/adr/0067-cline-free-catalog-bidirectional-sync.md。
 *
 * 纯逻辑（planSync）无 IO，可单测；IO 全走注入。
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
 * free 通道命名空间判据（裸 id）：`cline-free/<x>`、任意前缀下的 `*-free`、任意 `:free` 变体。
 * 只有落在这个集合里的既有条目才允许被自动移除；目录里出现的新 id 不设限（上游说免费即免费）。
 */
export function isFreeChannelId(id) {
  const s = String(id || "").trim().toLowerCase();
  if (!s) return false;
  if (s.startsWith("cline-free/")) return true;
  if (s.includes(":free")) return true;
  if (s.endsWith("-free") || s.endsWith("_free")) return true;
  return false;
}

/**
 * 求新白名单：先剔掉「属于 free 通道但已不在上游目录」的条目，再把上游新 id 追加到尾部。
 * @param {string[]} current 当前白名单（裸 id）
 * @param {string[]} upstreamIds 上游 free 目录 id（可带 provider 前缀，内部归一）
 * @param {{normalize?:Function, providerId?:string, isFreeChannel?:(bare:string)=>boolean}} [opts]
 * @returns {{next:string[], added:string[], removed:string[]}}
 */
export function planSync(current, upstreamIds, opts = {}) {
  const { normalize = defaultNormalize, providerId = "", isFreeChannel = isFreeChannelId } = opts;
  const cur = Array.isArray(current) ? current : [];
  const ups = (Array.isArray(upstreamIds) ? upstreamIds : [])
    .map((raw) => normalize(raw, providerId))
    .filter(Boolean);
  const upstream = new Set(ups);
  const next = [];
  const seen = new Set();
  const removed = [];
  for (const raw of cur) {
    const bare = normalize(raw, providerId);
    if (!bare) continue;
    if (seen.has(bare)) continue;
    if (isFreeChannel(bare) && !upstream.has(bare)) {
      removed.push(bare);
      continue;
    }
    seen.add(bare);
    next.push(bare);
  }
  const added = [];
  for (const bare of ups) {
    if (seen.has(bare)) continue;
    seen.add(bare);
    next.push(bare);
    added.push(bare);
  }
  return { next, added, removed };
}

/** 兼容旧名：只并集不改动既有条目（含 free 下架项）。保留导出供历史调用方/测试使用。 */
export function planMerge(current, upstreamIds, normalize = defaultNormalize, providerId = "") {
  const { next, added } = planSync(current, upstreamIds, { normalize, providerId, isFreeChannel: () => false });
  return { next, added };
}

/**
 * @param {object} opts
 * @param {string} opts.providerId
 * @param {() => string[]} opts.loadCurrent 读当前白名单（裸 id 数组）
 * @param {(id:string, list:string[]) => unknown} opts.persist 写回白名单
 * @param {(msg:string) => void} [opts.onLog]
 * @param {(m:string, pid:string)=>string} [opts.normalize]
 * @param {(bare:string)=>boolean} [opts.isFreeChannel]
 * @param {boolean} [opts.enabled] 显式覆盖 env 开关
 */
export function createAllowlistSync({ providerId, loadCurrent, persist, onLog, normalize = defaultNormalize, isFreeChannel = isFreeChannelId, enabled } = {}) {
  const isEnabled = () => {
    if (typeof enabled === "boolean") return enabled;
    return String(process.env.MSLXDFF_CLINE_AUTOSYNC ?? "") !== "0";
  };
  const log = (msg) => { try { onLog?.(msg); } catch {} };

  /**
   * 把一批上游 free 模型同步进白名单（新增并入、free 通道下架移除）。
   * @param {{id?:string}[]|string[]} models 上游模型对象数组或 id 数组
   * @returns {{skipped:string, added:string[], removed:string[], total:number}}
   */
  function syncIds(models) {
    if (!isEnabled()) return { skipped: "disabled", added: [], removed: [], total: 0 };
    if (!Array.isArray(models) || !models.length) return { skipped: "empty", added: [], removed: [], total: 0 };
    try {
      const ids = models.map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean);
      const cur = loadCurrent() || [];
      const { next, added, removed } = planSync(cur, ids, { normalize, providerId, isFreeChannel });
      if (!added.length && !removed.length) return { skipped: "", added: [], removed: [], total: next.length };
      persist(providerId, next);
      const parts = [];
      if (added.length) parts.push(`+${added.length}`);
      if (removed.length) parts.push(`-${removed.length}`);
      log(`[${providerId}] allowlist auto-sync: ${parts.join("/")} → ${next.length} total${
        added.length ? ` (added: ${added.join(", ")})` : ""}${removed.length ? ` (removed: ${removed.join(", ")})` : ""}`);
      return { skipped: "", added, removed, total: next.length };
    } catch (err) {
      // 同步是增益动作，失败绝不打断模型列表读取与请求链路
      log(`[${providerId}] allowlist auto-sync failed: ${String(err?.message || err)}`);
      return { skipped: "error", added: [], removed: [], total: 0 };
    }
  }

  return { syncIds };
}
